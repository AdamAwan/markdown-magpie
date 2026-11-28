// Recovery from a git process that was killed part-way (watcher crash, OOM kill,
// container stop) and left shared checkout state behind (docs/proposals-and-publishing.md
// P22–P24, docs/ingestion.md IN42). Every function here mutates a checkout's `.git`, so
// callers MUST hold that checkout's withCheckoutLock: inside this process the lock
// guarantees none of OUR git children is running against the checkout, and the age
// checks below cover a git started by another process on a shared volume.
import { readdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { GIT_CLONE_TIMEOUT_MS, GIT_SUBPROCESS_TIMEOUT_MS, git, tryGit, type GitRunOptions } from "./run-git.js";

// Lock files git creates at the top of a repository's git dir for the operations we
// run (checkout/reset/commit/worktree add/config/fetch). A crash between create and
// rename leaves one behind and every later git on the checkout fails with
// "Unable to create '…/index.lock': File exists".
const TOP_LEVEL_LOCK_FILES = ["index.lock", "HEAD.lock", "config.lock", "packed-refs.lock", "shallow.lock"];

// A lock is only stale once it is older than any git subprocess of ours could live:
// every one is killed at GIT_TIMEOUT_MS, so twice that is a safe floor. A younger
// lock may still belong to a live git (e.g. the API and watcher sharing a volume)
// and is left alone — the operation then fails as a transient lock error and the
// job queue retries it later, by which time the lock has either been released or
// aged into staleness.
function staleLockAgeMs(): number {
  return GIT_SUBPROCESS_TIMEOUT_MS * 2;
}

// Removes stale top-level lock files from `checkoutPath`'s git dir. Returns the
// paths removed. A missing git dir or lock is not an error.
export async function clearStaleGitLocks(
  checkoutPath: string,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<string[]> {
  const gitDir = path.join(checkoutPath, ".git");
  const maxAgeMs = options.maxAgeMs ?? staleLockAgeMs();
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  for (const name of TOP_LEVEL_LOCK_FILES) {
    const lockPath = path.join(gitDir, name);
    let modifiedAt: number;
    try {
      const info = await stat(lockPath);
      if (!info.isFile()) {
        continue;
      }
      modifiedAt = info.mtimeMs;
    } catch {
      continue;
    }
    if (now - modifiedAt < maxAgeMs) {
      continue;
    }
    try {
      await unlink(lockPath);
      removed.push(lockPath);
    } catch {
      // Released (renamed by its owner) between stat and unlink — nothing to do.
    }
  }
  return removed;
}

interface WorktreeEntry {
  path: string;
  branch?: string;
}

function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      entries.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length);
    }
  }
  return entries;
}

// Makes `branchName` available for a fresh `git worktree add -B` on `root`.
//
// A publish that was killed between `worktree add` and its cleanup leaves the
// worktree REGISTERED in `.git/worktrees/`, with the proposal branch checked out in
// it. Every retry then fails with "'<branch>' is already used by worktree at …"
// (or "already checked out"). So, under the checkout lock:
//   1. `git worktree prune` drops registrations whose directory is gone (the usual
//      case after a container restart wipes tmp);
//   2. any remaining linked worktree that still has THIS branch checked out is a
//      leftover of a dead publish of the same proposal (a live one would hold the
//      lock) and is force-removed — its directory too, if git cannot remove it;
//   3. prune again so a directory we deleted by hand is unregistered.
// The main working tree is never touched, and worktrees on other branches are left
// alone. Returns the worktree paths removed.
export async function releaseStaleBranchWorktrees(
  root: string,
  branchName: string,
  options: Pick<GitRunOptions, "signal"> = {}
): Promise<string[]> {
  await tryGit(root, ["worktree", "prune"], options);
  const listing = await tryGit(root, ["worktree", "list", "--porcelain"], options);
  const [, ...linked] = parseWorktreeList(listing);
  const ref = `refs/heads/${branchName}`;
  const removed: string[] = [];
  for (const entry of linked) {
    if (entry.branch !== ref) {
      continue;
    }
    try {
      // Double --force also removes a worktree that is locked or has a dirty index.
      await git(root, ["worktree", "remove", "--force", "--force", entry.path], options);
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      await rm(entry.path, { recursive: true, force: true });
    }
    removed.push(entry.path);
  }
  if (removed.length > 0) {
    await git(root, ["worktree", "prune"], options);
  }
  return removed;
}

// Prefix of the temporary directory a first clone is written into (a hidden
// sibling of the final checkout in the same checkout root, so the final rename is
// atomic on one filesystem).
export function cloneStagingPrefix(checkoutName: string): string {
  return `.${checkoutName}.clone-`;
}

// Removes leftover clone staging directories for `checkoutName` — a clone that was
// killed (timeout, crash, abort) before it could be renamed into place. A staging
// dir younger than the clone timeout may belong to a clone still running in another
// process on a shared volume and is kept. Returns the paths removed.
export async function removeStaleCloneStaging(
  checkoutRoot: string,
  checkoutName: string,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<string[]> {
  const prefix = cloneStagingPrefix(checkoutName);
  const maxAgeMs = options.maxAgeMs ?? GIT_CLONE_TIMEOUT_MS * 2;
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = await readdir(checkoutRoot);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const stagingPath = path.join(checkoutRoot, name);
    try {
      const info = await stat(stagingPath);
      if (now - info.mtimeMs < maxAgeMs) {
        continue;
      }
    } catch {
      continue;
    }
    await rm(stagingPath, { recursive: true, force: true });
    removed.push(stagingPath);
  }
  return removed;
}
