import type {
  CreatePullRequestRequest,
  CreatePullRequestResponse,
  PublishChangesetRequest,
  PublishProposalBranchRequest,
  PublishProposalBranchResponse,
  PullRequestProvider,
  RepositoryRef,
  ReviewDecision
} from "@magpie/core";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { withCheckoutLock } from "./checkout-lock.js";
import { withGitRetry } from "./git-retry.js";

const execFileAsync = promisify(execFile);

// A hung git subprocess (e.g. a credential prompt on a misconfigured remote) or
// a stalled GitHub connection would otherwise block indexing and the PR poller
// indefinitely; large diffs/clones could also blow past execFile's 1 MB default
// stdout buffer. These bounds are configurable for unusually large repos.
const GIT_SUBPROCESS_TIMEOUT_MS = positiveIntFromEnv("GIT_TIMEOUT_MS", 120_000);
const GIT_SUBPROCESS_MAX_BUFFER = positiveIntFromEnv("GIT_MAX_BUFFER_BYTES", 64 * 1024 * 1024);
const GITHUB_API_TIMEOUT_MS = positiveIntFromEnv("GITHUB_API_TIMEOUT_MS", 30_000);

// Clone source/destination checkouts as BLOBLESS PARTIAL CLONES (--filter=blob:none):
// the full commit/ref graph is fetched (so last_sha..HEAD diffs and origin/<branch>
// publishing still resolve every ref/commit) but historical file blobs are deferred
// and fetched on demand only for the files actually touched. For a very large source
// repo this avoids downloading every historical blob up front. Deliberately NOT
// shallow-by-depth: source-sync diffs last_sha..HEAD and a prior last_sha outside a
// shallow window would make the diff silently empty (missed changes); blobless
// filtering keeps all commits/refs so neither diffs nor publishing lose anything.
// Default on; can be disabled (GIT_PARTIAL_CLONE=0/false/off) for hosts that don't
// support partial clone — and we also auto-fall-back to a normal clone if --filter
// is rejected, so a non-supporting remote still ends up with a working checkout.
// Read per call (not memoized) so the toggle takes effect without a restart.
function partialCloneEnabled(): boolean {
  return boolFromEnv("GIT_PARTIAL_CLONE", true);
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return false;
  }
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") {
    return true;
  }
  return fallback;
}

export interface RepositorySyncResult {
  repository: RepositoryRef;
  headSha?: string;
  changedPaths: string[];
}

export interface RepositorySyncProvider {
  sync(repository: RepositoryRef): Promise<RepositorySyncResult>;
}

export interface GitCheckoutRequest {
  id: string;
  url: string;
  checkoutRoot: string;
  branch?: string;
}

export interface GitCheckoutResult {
  localPath: string;
  remoteUrl: string;
}

export class LocalRepositorySyncProvider implements RepositorySyncProvider {
  async sync(repository: RepositoryRef): Promise<RepositorySyncResult> {
    return {
      repository,
      changedPaths: []
    };
  }
}

export async function ensureGitCheckout(request: GitCheckoutRequest): Promise<GitCheckoutResult> {
  const localPath = path.join(request.checkoutRoot, safeCheckoutName(request.id));
  await mkdir(request.checkoutRoot, { recursive: true });
  const authEnv = buildGitAuthEnv(request.url);

  // Serialize all mutating git against this checkout: the api and the watcher both
  // clone/fetch/reset the same working trees, and the api fires this from several
  // concurrent async paths (reconcile, execution-context, snapshot, source-sync,
  // indexing). Concurrent git on one `.git` races on FETCH_HEAD/index.lock/refs.
  await withCheckoutLock(localPath, async () => {
    if (!existsSync(path.join(localPath, ".git"))) {
      await cloneCheckout(request, localPath, authEnv);
      return;
    }

    const currentRemote = await tryGit(localPath, ["remote", "get-url", "origin"]);
    if (currentRemote.trim() && currentRemote.trim() !== request.url) {
      throw new Error(`Configured checkout ${localPath} already points at ${currentRemote.trim()}`);
    }
    if (!currentRemote.trim()) {
      await git(localPath, ["remote", "add", "origin", request.url]);
    }
    await git(localPath, ["fetch", "--prune", "origin"], authEnv);

    // Bring the working tree to the remote tip with `reset --hard origin/<branch>`
    // rather than `pull --ff-only`. These checkouts are bot-owned and never hold
    // local edits worth keeping, so a deterministic reset is correct — and it avoids
    // the pull's FETCH_HEAD merge resolution, which (after `fetch --prune` populates
    // every remote branch) aborts with "Cannot fast-forward to multiple branches"
    // under concurrency. A reset can't fast-forward-fail or hit a merge ambiguity.
    const branch = request.branch?.trim() || (await tryGit(localPath, ["branch", "--show-current"])).trim();
    if (branch && (await remoteBranchExists(localPath, branch, authEnv))) {
      if (request.branch?.trim()) {
        // checkout materializes the work tree; on a blobless clone this may lazily
        // fetch blobs, so it needs the same auth as the clone/fetch.
        await git(localPath, ["checkout", branch], authEnv);
      }
      await git(localPath, ["reset", "--hard", `origin/${branch}`], authEnv);
    }
  });

  return {
    localPath,
    remoteUrl: request.url
  };
}

// Clones a fresh checkout, preferring a blobless partial clone (gated by
// partialCloneEnabled / GIT_PARTIAL_CLONE). Adds `--no-tags` so the (potentially large) tag
// namespace isn't fetched — source-sync and publishing resolve branches/commits,
// never tags. If the remote rejects `--filter` (older/self-hosted Git without
// partial-clone support), the partial directory is cleaned up and a plain clone is
// retried, so a non-supporting remote still ends up with a working checkout.
async function cloneCheckout(
  request: GitCheckoutRequest,
  localPath: string,
  authEnv: Partial<NodeJS.ProcessEnv>
): Promise<void> {
  const baseArgs: string[] = [];
  if (request.branch?.trim()) {
    baseArgs.push("--branch", request.branch.trim());
  }
  baseArgs.push("--no-tags");

  if (partialCloneEnabled()) {
    try {
      await git(
        request.checkoutRoot,
        ["clone", "--filter=blob:none", ...baseArgs, request.url, localPath],
        authEnv
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "partial clone failed";
      // A partial clone failed. The likeliest recoverable cause is a remote that
      // doesn't support the blob:none filter; anything else (bad URL, auth, network)
      // is a genuine failure that must surface rather than masquerade as "no partial
      // clone support". Either way a half-written checkout may be left behind, so
      // remove it before deciding so a fallback retry starts from a clean directory.
      await rm(localPath, { force: true, recursive: true }).catch(() => undefined);
      if (!isPartialCloneUnsupported(message)) {
        throw error instanceof Error ? error : new Error(message);
      }
      // Fall through to a plain clone below.
    }
  }

  await git(request.checkoutRoot, ["clone", ...baseArgs, request.url, localPath], authEnv);
}

// True when a `--filter=blob:none` clone failed because the remote/host doesn't
// support partial clone (older or self-hosted Git, or uploadpack.allowFilter off).
// Git has no stable machine-readable code for this, so we match the messages those
// implementations emit when rejecting a filtered fetch.
function isPartialCloneUnsupported(message: string): boolean {
  return (
    /filter/i.test(message) &&
    /(not support|unsupported|unknown|invalid|does not allow|not allowed|unrecognized|expected)/i.test(message)
  ) || /uploadpack\.allowfilter|allow.?filter|partial clone/i.test(message);
}

// A single file touched by a range of source commits. `diff` is the unified
// patch for that file, truncated to keep model input bounded.
export interface SourceFileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "other";
  diff: string;
}

// The current commit on the checkout's HEAD, or undefined when the path is not a
// git work tree (so callers can degrade rather than throw).
export async function getHeadSha(localPath: string): Promise<string | undefined> {
  const sha = (await tryGit(localPath, ["rev-parse", "HEAD"])).trim();
  return sha || undefined;
}

// The result of diffing two commits: the per-file changes (each with a capped
// patch) and the TRUE number of files the range touched. `totalCount` always
// reflects every changed file even when `changes` was capped via `maxFiles`, so a
// caller can record the real magnitude of a commit without materializing a patch
// string per file.
export interface DiffChangedFilesResult {
  changes: SourceFileChange[];
  totalCount: number;
}

// The files changed between two commits, with a (capped) per-file patch. Scope to
// a subdirectory with `subpath` so a source's configured subpath is the only
// thing diffed. Returns { changes: [], totalCount: 0 } when either ref is missing
// or nothing changed.
//
// Implemented as exactly two git subprocesses regardless of how many files
// changed: one `--name-status` call for the per-file statuses, and one plain
// `git diff` over the whole range whose unified output is then split per file
// in-process. A commit touching hundreds of files previously meant one `git
// diff` subprocess per file (process spawn + full git invocation each time),
// which dominated source-sync latency on large commits.
//
// `maxFiles` bounds memory for a pathological commit: only the first N files (in
// name-status order) get a patch string built, while `totalCount` still reports
// the true number of changed files (read cheaply from the name-status output). The
// patch-building diff is itself scoped to those first N pathspecs so git never has
// to emit (and this process never has to hold) the full multi-megabyte diff.
//
// `authEnv` is threaded onto the git invocations so that, against a blobless
// partial clone, the on-demand fetch of a changed file's OLD blob (which `git diff
// fromSha..toSha` needs and which may not be present locally) is authenticated the
// same way the clone/fetch was — otherwise private-repo diffs would fail. Both
// passes use `git` (not `tryGit`) so a lazy-fetch/auth failure surfaces as an error
// rather than being swallowed into an empty diff that would silently miss changes.
export async function diffChangedFiles(
  localPath: string,
  fromSha: string,
  toSha: string,
  options: { subpath?: string; maxDiffChars?: number; maxFiles?: number; authEnv?: Partial<NodeJS.ProcessEnv> } = {}
): Promise<DiffChangedFilesResult> {
  const maxDiffChars = options.maxDiffChars ?? 8_000;
  const subpathArgs = options.subpath?.trim() ? ["--", options.subpath.trim()] : [];
  const authEnv = options.authEnv;

  const nameStatus = await git(localPath, ["diff", "--name-status", "-M", `${fromSha}..${toSha}`, ...subpathArgs], authEnv);
  const allEntries = parseNameStatus(nameStatus);
  const totalCount = allEntries.length;

  const limit = options.maxFiles && options.maxFiles > 0 ? options.maxFiles : undefined;
  const entries = limit === undefined ? allEntries : allEntries.slice(0, limit);
  if (entries.length === 0) {
    return { changes: [], totalCount };
  }

  // Scope the patch-building diff to exactly the files we will materialize. When
  // truncating, this also keeps git from generating the full diff of every file.
  // The pathspecs use ":(literal)" so paths with glob metacharacters match verbatim;
  // for a rename we name both endpoints so the patch chunk still resolves.
  const truncating = limit !== undefined && entries.length < totalCount;
  const patchPathspec = truncating
    ? [
        "--",
        ...entries.flatMap((entry) =>
          entry.oldPath && entry.oldPath !== entry.path
            ? [`:(literal)${entry.path}`, `:(literal)${entry.oldPath}`]
            : [`:(literal)${entry.path}`]
        )
      ]
    : subpathArgs;
  const fullDiff = await git(localPath, ["diff", "-M", `${fromSha}..${toSha}`, ...patchPathspec], authEnv);

  const diffByPath = splitUnifiedDiffByFile(fullDiff);
  const changes: SourceFileChange[] = [];

  for (const entry of entries) {
    const status: SourceFileChange["status"] =
      entry.code === "A"
        ? "added"
        : entry.code === "M"
          ? "modified"
          : entry.code === "D"
            ? "deleted"
            : entry.code === "R"
              ? "renamed"
              : "other";

    const rawDiff = diffByPath.get(entry.path) ?? "";
    const diff = rawDiff.length > maxDiffChars ? `${rawDiff.slice(0, maxDiffChars)}\n… (diff truncated)` : rawDiff;
    changes.push({ path: entry.path, status, diff });
  }

  return { changes, totalCount };
}

// Splits a multi-file unified diff (as produced by `git diff`) into one entry
// per file, keyed by the file's "current" path (the `b/` side, or the `a/`
// side for a deleted file with no `b/` side) — i.e. the same path
// `--name-status` reports. Each entry's value is that file's own `diff --git
// ...` chunk, verbatim.
function splitUnifiedDiffByFile(fullDiff: string): Map<string, string> {
  const byPath = new Map<string, string>();
  if (!fullDiff) {
    return byPath;
  }

  // Each file's chunk starts with a "diff --git a/<old> b/<new>" header line;
  // splitting on that boundary (keeping it via a lookahead) yields one chunk
  // per file without needing to understand hunk syntax.
  const chunks = fullDiff.split(/(?=^diff --git )/m).filter((chunk) => chunk.length > 0);

  for (const chunk of chunks) {
    const header = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?\r?\n/.exec(chunk);
    if (!header) {
      continue;
    }
    const [, oldPath, newPath] = header;
    // For a deleted file the diff has no `b/` side content, but the header still
    // names it `b/<path>` (same as the old path) — using newPath covers every
    // status `--name-status` can report (A/M/D/R) since git mirrors the path
    // there even when the file no longer exists at toSha.
    byPath.set(newPath, chunk);
    if (oldPath !== newPath) {
      byPath.set(oldPath, chunk);
    }
  }

  return byPath;
}

// One parsed line of `git diff --name-status -M` output. `code` is the leading
// status letter (A/M/D/R/C/T/U/...); `path` is the file's current path (the
// rename/copy target); `oldPath` is the pre-rename source, present only for R/C.
interface NameStatusEntry {
  code: string;
  path: string;
  oldPath?: string;
}

// Parses `git diff --name-status` output into structured entries. A/M/D lines are
// "<code>\t<path>"; R/C lines are "<code><score>\t<oldPath>\t<newPath>". Shared by
// diffChangedFiles and listChangedMarkdown so the tab/rename handling lives once.
function parseNameStatus(nameStatus: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of nameStatus.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split(/\t/);
    const code = parts[0]?.[0] ?? "";
    if (code === "R" || code === "C") {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (!oldPath || !newPath) {
        continue;
      }
      entries.push({ code, path: newPath, oldPath });
      continue;
    }
    const filePath = parts[1];
    if (!filePath) {
      continue;
    }
    entries.push({ code, path: filePath });
  }
  return entries;
}

// A single markdown file changed between two commits, identified by name-status
// only (no patch body). `oldPath` is the pre-rename path on a rename/copy; for
// added/modified/deleted it is undefined. `path` is always the post-change path
// (the rename target), relative to the work-tree root.
export interface ChangedMarkdownFile {
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
  path: string;
  oldPath?: string;
}

// Lists the markdown files that changed between two commits using a name-status
// diff (no patch bodies — far cheaper than diffChangedFiles when the caller only
// needs to know *which* files to re-read). Scope to a subtree with `pathspec`.
// Returns [] when either ref is missing or nothing changed, so callers can treat
// "couldn't diff" as "no incremental work" and fall back to a full reindex.
export async function listChangedMarkdown(
  localPath: string,
  fromSha: string,
  toSha: string,
  options: { pathspec?: string } = {}
): Promise<ChangedMarkdownFile[]> {
  const subtree = options.pathspec?.replace(/\/+$/, "").trim();
  // Scope the diff to the subtree with a ":(literal)" pathspec so directory names
  // containing glob metacharacters ([ ] * ?) are matched verbatim rather than
  // interpreted — a glob pathspec built from an arbitrary directory name would
  // silently match nothing. The pathspec matches the directory and everything
  // under it; the *.md filter is then applied per result path below.
  const pathspec = subtree && subtree !== "." ? [`:(literal)${subtree}`] : [];
  const subtreePrefix = subtree && subtree !== "." ? `${subtree}/` : undefined;
  const nameStatus = await tryGit(localPath, [
    "diff",
    "--name-status",
    "-M",
    `${fromSha}..${toSha}`,
    "--",
    ...pathspec
  ]);

  const isMarkdownInSubtree = (filePath: string): boolean => {
    if (!filePath.toLowerCase().endsWith(".md")) {
      return false;
    }
    return subtreePrefix === undefined || filePath.startsWith(subtreePrefix);
  };

  const changes: ChangedMarkdownFile[] = [];
  for (const entry of parseNameStatus(nameStatus)) {
    if (entry.code === "R" || entry.code === "C") {
      // A rename/copy is relevant if either endpoint is a markdown file inside
      // the subtree (a move into or out of the scope still changes the index).
      if (!entry.oldPath || (!isMarkdownInSubtree(entry.oldPath) && !isMarkdownInSubtree(entry.path))) {
        continue;
      }
      changes.push({ status: entry.code === "R" ? "renamed" : "copied", path: entry.path, oldPath: entry.oldPath });
      continue;
    }

    if (!isMarkdownInSubtree(entry.path)) {
      continue;
    }
    const status = entry.code === "A" ? "added" : entry.code === "D" ? "deleted" : "modified";
    changes.push({ status, path: entry.path });
  }

  return changes;
}

// True when `ancestorSha` is an ancestor of (or equal to) `descendantSha` —
// i.e. the prior commit is still reachable from the current HEAD, so history
// was not rewritten between them. Uses `git merge-base --is-ancestor`, whose
// exit code is the answer (0 = ancestor, 1 = not). Returns false on any error
// (bad/missing ref), so an undecidable check fails closed to a full reindex.
export async function isAncestor(
  localPath: string,
  ancestorSha: string,
  descendantSha: string
): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha], {
      cwd: localPath,
      timeout: GIT_SUBPROCESS_TIMEOUT_MS,
      maxBuffer: GIT_SUBPROCESS_MAX_BUFFER
    });
    return true;
  } catch {
    return false;
  }
}

export class DryRunPullRequestProvider implements PullRequestProvider {
  async createPullRequest(request: CreatePullRequestRequest): Promise<CreatePullRequestResponse> {
    return {
      id: `dry-run:${request.branchName}`,
      url: `file://${request.repository.localPath}`,
      status: "open"
    };
  }
}

export interface RaisePullRequestRequest {
  // Remote the published branch lives on. Used to derive the host and repo slug.
  remoteUrl: string | undefined;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface RaisedPullRequest {
  url: string;
  number: number;
}

// Opens a pull request for an already-pushed branch. Returns undefined when the
// remote host is unsupported or no token is configured, so callers can degrade
// to a branch-only publish. Throws only when a supported host's API rejects the
// request, so genuine failures surface rather than being silently swallowed.
export async function raisePullRequest(request: RaisePullRequestRequest): Promise<RaisedPullRequest | undefined> {
  const slug = parseGitHubSlug(request.remoteUrl);
  if (!slug) {
    return undefined;
  }

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return undefined;
  }

  const response = await githubFetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "markdown-magpie"
    },
    body: JSON.stringify({
      title: request.title,
      head: request.headBranch,
      base: request.baseBranch,
      body: request.body
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // A branch that already has an open PR returns 422. That's not a failure for
    // us — the desired end state (an open PR for this branch) already holds — so
    // adopt the existing one and return it instead of throwing and forcing the
    // publication outbox to retry a request that can never succeed.
    if (response.status === 422 && /already exists/i.test(detail)) {
      const existing = await findOpenPullRequest(slug, token, request.headBranch);
      if (existing) {
        return existing;
      }
    }
    throw new Error(`GitHub pull request creation failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  const data = (await response.json()) as { html_url?: string; number?: number };
  if (!data.html_url || typeof data.number !== "number") {
    throw new Error("GitHub pull request creation returned an unexpected response");
  }

  return { url: data.html_url, number: data.number };
}

// Looks up the open pull request already raised for a branch, so a duplicate
// create attempt (422) can resolve to the live PR. Returns undefined when none
// is found or the lookup fails — the caller then surfaces the original error.
async function findOpenPullRequest(
  slug: { owner: string; repo: string },
  token: string,
  headBranch: string
): Promise<RaisedPullRequest | undefined> {
  const head = `${slug.owner}:${headBranch}`;
  const url = `https://api.github.com/repos/${slug.owner}/${slug.repo}/pulls?state=open&head=${encodeURIComponent(head)}`;
  let response: Response;
  try {
    response = await githubFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "markdown-magpie"
      }
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    return undefined;
  }
  const list = (await response.json().catch(() => [])) as Array<{ html_url?: string; number?: number }>;
  const match = list.find((pr) => pr.html_url && typeof pr.number === "number");
  return match ? { url: match.html_url as string, number: match.number as number } : undefined;
}

// Whether an open PR still merges cleanly into its base. GitHub computes this
// asynchronously, so a freshly-pushed or freshly-changed PR reads "unknown" until
// the background check settles — callers must treat "unknown" as "no signal", never
// as a trigger. "conflicting" means the base moved under the branch and the merge no
// longer applies.
export type PullRequestMergeability = "mergeable" | "conflicting" | "unknown";

export interface PullRequestStatus {
  merged: boolean;
  // GitHub reports a merged PR as state "closed"; `merged` disambiguates a merge
  // from a close-without-merge.
  state: "open" | "closed";
  // Derived from GitHub's `mergeable` / `mergeable_state` fields on the PR read.
  mergeable: PullRequestMergeability;
}

// Maps GitHub's PR `mergeable` (true | false | null) and `mergeable_state`
// (clean | dirty | blocked | behind | unstable | unknown) onto our tri-state.
// `mergeable_state === "dirty"` is GitHub's explicit "has conflicts" marker; a
// boolean `mergeable === false` corroborates it. Anything not yet computed (null /
// "unknown") is reported as "unknown" so callers never act on an unsettled read.
export function toMergeability(
  mergeable: boolean | null | undefined,
  mergeableState: string | undefined
): PullRequestMergeability {
  if (mergeable === false || mergeableState === "dirty") {
    return "conflicting";
  }
  if (mergeable === true) {
    return "mergeable";
  }
  return "unknown";
}

export interface PullRequestPoll {
  // True when the server answered 304 Not Modified to a conditional request: the
  // PR is unchanged since `etag`, so the caller keeps its cached reading. A 304
  // does not count against GitHub's REST rate limit.
  notModified: boolean;
  // The freshly-read state (200 response). Undefined when the URL is not a GitHub
  // PR, no token is configured, the PR is gone (404), or on a 304.
  status?: PullRequestStatus;
  // The ETag to store and replay as If-None-Match next time (present on a 200).
  etag?: string;
}

// Reads a previously-raised GitHub pull request, optionally conditionally: pass
// the ETag from a prior poll and an unchanged PR comes back as 304 (notModified)
// without spending rate limit or re-reading the body. Returns notModified=false
// with status undefined when the URL is not a GitHub PR, no token is configured,
// or the PR can no longer be found. Throws only on an unexpected API error.
export async function fetchPullRequestStatusCached(
  pullRequestUrl: string | undefined,
  etag?: string
): Promise<PullRequestPoll> {
  const ref = parseGitHubPullRequestUrl(pullRequestUrl);
  if (!ref) {
    return { notModified: false };
  }

  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return { notModified: false };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "markdown-magpie"
  };
  if (etag) {
    headers["If-None-Match"] = etag;
  }

  const response = await githubFetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
    { headers }
  );

  if (response.status === 304) {
    return { notModified: true };
  }
  if (response.status === 404) {
    return { notModified: false };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub pull request lookup failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    merged?: boolean;
    state?: string;
    mergeable?: boolean | null;
    mergeable_state?: string;
  };
  return {
    notModified: false,
    status: {
      merged: Boolean(data.merged),
      state: data.state === "closed" ? "closed" : "open",
      mergeable: toMergeability(data.mergeable, data.mergeable_state)
    },
    etag: response.headers.get("etag") ?? undefined
  };
}

// Unconditional read, for callers that have no cached ETag. Returns undefined in
// all the skip cases above. Kept as the simple shape the live PR-state fallback uses.
export async function fetchPullRequestStatus(pullRequestUrl: string | undefined): Promise<PullRequestStatus | undefined> {
  return (await fetchPullRequestStatusCached(pullRequestUrl)).status;
}

// Reads a pull request's review decision. GitHub's GraphQL reviewDecision is the
// authoritative "approved per policy" signal (it accounts for required reviewers,
// CODEOWNERS, and branch protection). When the repository requires no reviews
// GitHub returns null; we then fall back to the REST reviews list and treat any
// human approval with no outstanding change request as approved. Returns undefined
// in the same skip cases as fetchPullRequestStatus (not a GitHub PR url, no token)
// and on any lookup error, so callers treat "couldn't determine" uniformly — an
// undetermined decision leaves the PR touchable.
export async function fetchPullRequestReviewDecision(
  pullRequestUrl: string | undefined
): Promise<ReviewDecision | undefined> {
  const ref = parseGitHubPullRequestUrl(pullRequestUrl);
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!ref || !token) {
    return undefined;
  }
  try {
    const decision = await readReviewDecisionFromGraphql(ref, token);
    if (decision !== null) {
      return decision;
    }
    return await readApprovalFromReviews(ref, token);
  } catch {
    // A failed review lookup must never fail the refresh job; "couldn't determine"
    // is reported as undefined and treated as touchable downstream.
    return undefined;
  }
}

type PullRequestRef = { owner: string; repo: string; number: number };

// GraphQL reviewDecision → our enum. Returns null when GitHub has no policy verdict
// (the repo requires no reviews), signalling the caller to use the reviews fallback.
async function readReviewDecisionFromGraphql(
  ref: PullRequestRef,
  token: string
): Promise<Exclude<ReviewDecision, "none"> | null> {
  const query =
    "query($owner:String!,$repo:String!,$number:Int!){" +
    "repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewDecision}}}";
  const response = await githubFetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "markdown-magpie"
    },
    body: JSON.stringify({ query, variables: { owner: ref.owner, repo: ref.repo, number: ref.number } })
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL review lookup failed (${response.status})`);
  }
  const body = (await response.json()) as {
    data?: { repository?: { pullRequest?: { reviewDecision?: string | null } } };
  };
  switch (body.data?.repository?.pullRequest?.reviewDecision ?? null) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return null;
  }
}

// REST fallback: reduce the reviews list (oldest-first) to the latest meaningful
// review per author, then any outstanding change request loses, else any approval
// wins, else none.
async function readApprovalFromReviews(ref: PullRequestRef, token: string): Promise<ReviewDecision> {
  const response = await githubFetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "markdown-magpie"
      }
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub reviews lookup failed (${response.status})`);
  }
  const reviews = (await response.json()) as Array<{ state?: string; user?: { login?: string } | null }>;
  const latestByAuthor = new Map<string, "APPROVED" | "CHANGES_REQUESTED">();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login) continue;
    switch (review.state) {
      case "APPROVED":
        latestByAuthor.set(login, "APPROVED");
        break;
      case "CHANGES_REQUESTED":
        latestByAuthor.set(login, "CHANGES_REQUESTED");
        break;
      case "DISMISSED":
        latestByAuthor.delete(login);
        break;
      // COMMENTED / PENDING and anything else are not verdicts; ignore.
    }
  }
  const verdicts = [...latestByAuthor.values()];
  if (verdicts.includes("CHANGES_REQUESTED")) {
    return "changes_requested";
  }
  if (verdicts.includes("APPROVED")) {
    return "approved";
  }
  return "none";
}

// Parses owner/repo/number from a github.com pull request html_url such as
// https://github.com/owner/repo/pull/7.
function parseGitHubPullRequestUrl(
  pullRequestUrl: string | undefined
): { owner: string; repo: string; number: number } | undefined {
  if (!pullRequestUrl?.trim()) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(pullRequestUrl.trim());
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && !host.endsWith(".github.com")) {
    return undefined;
  }

  const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  // owner / repo / "pull" / number
  if (segments.length < 4 || segments[2] !== "pull") {
    return undefined;
  }

  const number = Number.parseInt(segments[3], 10);
  if (!Number.isInteger(number)) {
    return undefined;
  }

  return { owner: segments[0], repo: segments[1].replace(/\.git$/, ""), number };
}

// Extracts the owner/repo slug from an https or ssh github.com remote. Returns
// undefined for any other host so non-GitHub remotes degrade to branch-only.
function parseGitHubSlug(remoteUrl: string | undefined): { owner: string; repo: string } | undefined {
  if (!remoteUrl?.trim()) {
    return undefined;
  }

  const trimmed = remoteUrl.trim();
  // git@github.com:owner/repo(.git)
  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && !host.endsWith(".github.com")) {
    return undefined;
  }

  const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length < 2) {
    return undefined;
  }

  return { owner: segments[0], repo: segments[1].replace(/\.git$/, "") };
}

export class LocalGitProposalPublisher {
  async publish(request: PublishProposalBranchRequest): Promise<PublishProposalBranchResponse> {
    // Serialize worktree add/push against this checkout — they mutate the shared
    // `.git` (refs, config, worktree list) and would race a concurrent publish or
    // ensureGitCheckout on the same root (e.g. "could not lock config file").
    const root = request.repository.git?.workTreeRoot ?? request.repository.localPath;
    return withCheckoutLock(root, () => this.publishLocked(request, root));
  }

  private async publishLocked(
    request: PublishProposalBranchRequest,
    root: string
  ): Promise<PublishProposalBranchResponse> {
    const targetPath = resolveTargetPath(request.repository, request.targetPath);
    const remoteUrl = await ensureRemote(root);
    const authEnv = buildGitAuthEnv(remoteUrl);

    const remoteBranch = await tryGit(root, ["ls-remote", "--heads", "origin", request.branchName], authEnv);
    const branchExists = Boolean(remoteBranch.trim());

    const tempRoot = await mkdtemp(path.join(tmpdir(), "markdown-magpie-worktree-"));
    const worktreePath = path.join(tempRoot, "checkout");

    try {
      if (branchExists) {
        // Update path: base the worktree on the existing remote branch tip so our
        // new commit is a fast-forward — these branches are bot-owned, so the tip
        // is always our last push and no force is ever needed.
        await git(root, ["fetch", "origin", request.branchName], authEnv);
        await git(root, ["worktree", "add", "-B", request.branchName, worktreePath, `origin/${request.branchName}`]);
      } else {
        const baseRef = await resolveBaseRef(root, request.repository);
        await git(root, ["worktree", "add", "-B", request.branchName, worktreePath, baseRef]);
      }

      const absoluteTargetPath = path.resolve(worktreePath, targetPath);
      assertWithinRoot(worktreePath, absoluteTargetPath);
      await mkdir(path.dirname(absoluteTargetPath), { recursive: true });
      await writeFile(absoluteTargetPath, request.markdown, "utf8");
      await git(worktreePath, ["add", "--", targetPath]);

      const status = await git(worktreePath, ["status", "--porcelain", "--", targetPath]);
      if (!status.trim()) {
        // No content change. On the create path this is an error; on the update
        // path it just means the regenerated doc is identical — return the current tip.
        if (!branchExists) {
          throw new Error(`Proposal does not change ${targetPath}`);
        }
        const head = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
        return {
          branchName: request.branchName,
          commitSha: head,
          remoteUrl: request.repository.remoteUrl ?? request.repository.git?.remoteUrl
        };
      }

      const { name: authorName, email: authorEmail } = resolveCommitterIdentity();
      await git(worktreePath, [
        "-c",
        `user.name=${authorName}`,
        "-c",
        `user.email=${authorEmail}`,
        "commit",
        "-m",
        request.title
      ]);
      const commitSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
      await git(worktreePath, ["push", "-u", "origin", request.branchName], authEnv);

      return {
        branchName: request.branchName,
        commitSha,
        remoteUrl: request.repository.remoteUrl ?? request.repository.git?.remoteUrl
      };
    } finally {
      await cleanupWorktree(root, worktreePath, tempRoot);
    }
  }

  // Publishes a multi-file changeset (writes and deletes) to a single new
  // branch in one commit. If the branch already exists, updates it in place so
  // folded/reconciled changesets can republish onto their existing PR branch.
  async publishChangeset(request: PublishChangesetRequest): Promise<PublishProposalBranchResponse> {
    const root = request.repository.git?.workTreeRoot ?? request.repository.localPath;
    return withCheckoutLock(root, () => this.publishChangesetLocked(request, root));
  }

  private async publishChangesetLocked(
    request: PublishChangesetRequest,
    root: string
  ): Promise<PublishProposalBranchResponse> {
    const remoteUrl = await ensureRemote(root);
    const authEnv = buildGitAuthEnv(remoteUrl);
    const remoteBranch = await tryGit(root, ["ls-remote", "--heads", "origin", request.branchName], authEnv);
    const branchExists = Boolean(remoteBranch.trim());

    const tempRoot = await mkdtemp(path.join(tmpdir(), "markdown-magpie-worktree-"));
    const worktreePath = path.join(tempRoot, "checkout");

    try {
      if (branchExists) {
        await git(root, ["fetch", "origin", request.branchName], authEnv);
        await git(root, ["worktree", "add", "-B", request.branchName, worktreePath, `origin/${request.branchName}`]);
      } else {
        const baseRef = await resolveBaseRef(root, request.repository);
        await git(root, ["worktree", "add", "-B", request.branchName, worktreePath, baseRef]);
      }

      for (const change of request.changes) {
        const repoRelativePath = resolveTargetPath(request.repository, change.path);
        const absolutePath = path.resolve(worktreePath, repoRelativePath);
        assertWithinRoot(worktreePath, absolutePath);

        if (change.delete) {
          await tryGit(worktreePath, ["rm", "--ignore-unmatch", "--", repoRelativePath]);
          // git rm already removes the file; unlink covers untracked paths.
          await unlink(absolutePath).catch(() => undefined);
          continue;
        }

        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, change.content ?? "", "utf8");
        await git(worktreePath, ["add", "--", repoRelativePath]);
      }

      const status = await git(worktreePath, ["status", "--porcelain"]);
      if (!status.trim()) {
        if (branchExists) {
          const head = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
          return {
            branchName: request.branchName,
            commitSha: head,
            remoteUrl: request.repository.remoteUrl ?? request.repository.git?.remoteUrl
          };
        }
        throw new Error("Crunch plan does not change any files");
      }

      const { name: authorName, email: authorEmail } = resolveCommitterIdentity();
      await git(worktreePath, [
        "-c",
        `user.name=${authorName}`,
        "-c",
        `user.email=${authorEmail}`,
        "commit",
        "-m",
        request.title
      ]);
      const commitSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
      await git(worktreePath, ["push", "-u", "origin", request.branchName], authEnv);

      return {
        branchName: request.branchName,
        commitSha,
        remoteUrl: request.repository.remoteUrl ?? request.repository.git?.remoteUrl
      };
    } finally {
      await cleanupWorktree(root, worktreePath, tempRoot);
    }
  }
}

export interface MergeLocalProposalBranchRequest {
  // The destination repo's own working tree (the folder the user browses).
  // The proposal branch was already pushed here, so it exists as a local ref.
  repoPath: string;
  branchName: string;
  defaultBranch: string;
}

export interface MergeLocalProposalBranchResult {
  mergeCommitSha: string;
}

// Merges an already-pushed proposal branch into the destination's default branch,
// directly in the destination working tree, then deletes the branch. Always makes
// a merge commit (`--no-ff`) so the merge is explicit and needs the configured
// committer identity. On ANY failure (conflict, dirty tree, missing branch) it
// runs `git merge --abort` and throws, leaving the default branch exactly as it
// was — the caller must not advance the proposal on a throw.
export async function mergeLocalProposalBranch(
  request: MergeLocalProposalBranchRequest
): Promise<MergeLocalProposalBranchResult> {
  const { repoPath, branchName, defaultBranch } = request;
  return withCheckoutLock(repoPath, async () => {
    await git(repoPath, ["checkout", defaultBranch]);

    const { name, email } = resolveCommitterIdentity();
    try {
      await git(repoPath, [
        "-c",
        `user.name=${name}`,
        "-c",
        `user.email=${email}`,
        "merge",
        "--no-ff",
        "--no-edit",
        branchName
      ]);
    } catch (error) {
      // Undo a half-applied/conflicted merge so the working tree returns to the
      // default branch tip; best-effort so the original cause still surfaces.
      await tryGit(repoPath, ["merge", "--abort"]);
      const message = error instanceof Error ? error.message : "git merge failed";
      throw new Error(`Could not merge ${branchName} into ${defaultBranch}: ${message}`, { cause: error });
    }

    const mergeCommitSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    // The branch is fully merged now; delete it so the demo repo stays tidy.
    // A failed delete must not fail the merge.
    await tryGit(repoPath, ["branch", "-D", branchName]);
    return { mergeCommitSha };
  });
}

export interface DeleteLocalProposalBranchRequest {
  // The destination repo's own working tree (the folder the user browses). The
  // proposal branch was pushed here, so it exists as a local ref.
  repoPath: string;
  branchName: string;
  // Checked out first so the branch being deleted is never the current branch
  // (git refuses to delete the checked-out branch).
  defaultBranch: string;
}

// Deletes an unmerged proposal review branch from a local-git destination — the
// "Bin" (reject) action, the local analog of closing a pull request without
// merging. Checks out the default branch (so the deleted branch is never current),
// then force-deletes the branch. Best-effort delete: a missing branch is not an
// error (the desired end state — the branch is gone — already holds). Serialized on
// the checkout lock like merge/publish, since it mutates the shared `.git`.
export async function deleteLocalProposalBranch(
  request: DeleteLocalProposalBranchRequest
): Promise<void> {
  const { repoPath, branchName, defaultBranch } = request;
  await withCheckoutLock(repoPath, async () => {
    await git(repoPath, ["checkout", defaultBranch]);
    await tryGit(repoPath, ["branch", "-D", branchName]);
  });
}

function resolveTargetPath(repository: RepositoryRef, targetPath: string): string {
  const normalizedTargetPath = toPosixPath(targetPath).replace(/^\/+/, "");
  const relativePathFromRoot = repository.git?.relativePathFromRoot;
  if (!relativePathFromRoot || relativePathFromRoot === ".") {
    return normalizedTargetPath;
  }

  const normalizedRelativePath = toPosixPath(relativePathFromRoot).replace(/^\/+|\/+$/g, "");
  if (normalizedTargetPath === normalizedRelativePath || normalizedTargetPath.startsWith(`${normalizedRelativePath}/`)) {
    return normalizedTargetPath;
  }

  return `${normalizedRelativePath}/${normalizedTargetPath}`;
}

function resolveCommitterIdentity(): { name: string; email: string } {
  const name = process.env.MAGPIE_GIT_AUTHOR_NAME?.trim();
  const email = process.env.MAGPIE_GIT_AUTHOR_EMAIL?.trim();
  if (!name || !email) {
    throw new Error(
      "Cannot publish proposal because the commit identity is not configured. " +
        "Set MAGPIE_GIT_AUTHOR_NAME and MAGPIE_GIT_AUTHOR_EMAIL."
    );
  }
  return { name, email };
}

async function ensureRemote(root: string): Promise<string> {
  const remote = await git(root, ["remote", "get-url", "origin"]);
  if (!remote.trim()) {
    throw new Error("Cannot publish proposal because git remote 'origin' is not configured");
  }
  return remote.trim();
}

async function resolveBaseRef(root: string, repository: RepositoryRef): Promise<string> {
  const defaultBranch = repository.defaultBranch || repository.git?.defaultBranch || repository.git?.currentBranch || "main";
  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  const hasRemoteRef = await tryGit(root, ["show-ref", "--verify", remoteRef]);
  if (hasRemoteRef.trim()) {
    return `origin/${defaultBranch}`;
  }

  return defaultBranch;
}

// GitHub REST call with an abort-based timeout so the PR poller can't hang on a
// stalled connection. The TimeoutError is rethrown as a readable message.
async function githubFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`GitHub request timed out after ${GITHUB_API_TIMEOUT_MS}ms`, { cause: error });
    }
    throw error;
  }
}

async function git(cwd: string, args: string[], env?: Partial<NodeJS.ProcessEnv>): Promise<string> {
  return withGitRetry(async () => {
    try {
      const result = await execFileAsync("git", args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        timeout: GIT_SUBPROCESS_TIMEOUT_MS,
        maxBuffer: GIT_SUBPROCESS_MAX_BUFFER
      });
      return result.stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : "git command failed";
      throw new Error(message, { cause: error });
    }
  });
}

async function tryGit(cwd: string, args: string[], env?: Partial<NodeJS.ProcessEnv>): Promise<string> {
  try {
    return await git(cwd, args, env);
  } catch {
    return "";
  }
}

// Authenticate HTTPS git operations using a host-matched token, injected as an
// http.extraheader via GIT_CONFIG_* environment variables (git >= 2.31). The
// secret travels in the child's environment only — never in argv or the remote
// URL — so it can't leak into the command line that git() echoes back in error
// messages (which are surfaced to the UI). Returns {} when no token applies, so
// public repos, SSH remotes, and credential-embedded URLs keep working unchanged.
export function buildGitAuthEnv(remoteUrl: string | undefined): Partial<NodeJS.ProcessEnv> {
  const header = buildAuthHeader(remoteUrl);
  if (!header) {
    return {};
  }
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: header
  };
}

function buildAuthHeader(remoteUrl: string | undefined): string | undefined {
  if (!remoteUrl?.trim()) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl.trim());
  } catch {
    return undefined;
  }

  // SSH (git@/ssh://) authenticates with keys; credential-embedded URLs already
  // carry their own auth — don't override either.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  if (parsed.username || parsed.password) {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com")) {
    const token = process.env.GITHUB_TOKEN?.trim();
    return token ? basicAuthHeader("x-access-token", token) : undefined;
  }
  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
    const pat = process.env.AZURE_DEVOPS_PAT?.trim();
    return pat ? basicAuthHeader("pat", pat) : undefined;
  }

  return undefined;
}

function basicAuthHeader(username: string, secret: string): string {
  const encoded = Buffer.from(`${username}:${secret}`).toString("base64");
  return `Authorization: Basic ${encoded}`;
}

async function cleanupWorktree(root: string, worktreePath: string, tempRoot: string): Promise<void> {
  await tryGit(root, ["worktree", "remove", "--force", worktreePath]);
  await rm(tempRoot, { force: true, recursive: true });
}

function assertWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Proposal target path must stay inside the repository checkout");
  }
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

async function remoteBranchExists(
  root: string,
  branch: string,
  authEnv?: Partial<NodeJS.ProcessEnv>
): Promise<boolean> {
  const result = await tryGit(root, ["ls-remote", "--heads", "origin", branch], authEnv);
  return Boolean(result.trim());
}

function safeCheckoutName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repository"
  );
}

export interface CommentOnPullRequestRequest {
  pullRequestUrl: string;
  body: string;
}

// Post a comment on a pull request. GitHub treats PR comments as issue comments,
// so this targets the issues endpoint. Returns the created comment's URL, or
// undefined when there is no token or the URL is not a GitHub PR URL — quiet
// degradation symmetric with raisePullRequest.
export async function commentOnPullRequest(
  request: CommentOnPullRequestRequest
): Promise<string | undefined> {
  const target = parsePullRequestUrl(request.pullRequestUrl);
  if (!target) {
    return undefined;
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return undefined;
  }

  const response = await githubFetch(
    `https://api.github.com/repos/${target.owner}/${target.repo}/issues/${target.number}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "markdown-magpie"
      },
      body: JSON.stringify({ body: request.body })
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub PR comment failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  const data = (await response.json()) as { html_url?: string };
  return data.html_url;
}

function parsePullRequestUrl(
  url: string
): { owner: string; repo: string; number: number } | undefined {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) {
    return undefined;
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}
