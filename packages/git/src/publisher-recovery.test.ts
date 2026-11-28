import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { before, describe, it } from "node:test";
import { GitCommandError, LocalGitProposalPublisher } from "./index.js";
import { initBareRemoteWithClone } from "./test-support.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

const BRANCH = "magpie/proposal-abc12345-topic";

// Recreates what a watcher killed mid-publish leaves on the shared checkout: the
// temporary worktree is still REGISTERED with the proposal branch checked out in
// it, and git's index.lock (here: in the main checkout's git dir) was never
// released. Returns the leftover worktree's path.
async function simulateKilledPublish(root: string, options: { keepWorktreeDir: boolean }): Promise<string> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "markdown-magpie-worktree-"));
  const worktreePath = path.join(tempRoot, "checkout");
  await git(root, ["worktree", "add", "-B", BRANCH, worktreePath, "origin/main"]);
  await writeFile(path.join(worktreePath, "half-written.md"), "# partial\n", "utf8");
  if (!options.keepWorktreeDir) {
    // e.g. the container restarted and tmp was wiped, but .git/worktrees survived
    // on the checkout volume.
    await rm(tempRoot, { recursive: true, force: true });
  }
  const lock = path.join(root, ".git", "index.lock");
  await writeFile(lock, "");
  const longAgo = new Date(Date.now() - 60 * 60_000);
  await utimes(lock, longAgo, longAgo);
  return worktreePath;
}

async function registeredWorktrees(root: string): Promise<string[]> {
  const listing = await git(root, ["worktree", "list", "--porcelain"]);
  return listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .slice(1);
}

describe("LocalGitProposalPublisher recovery from a killed publish (P22–P24)", () => {
  before(() => {
    process.env.MAGPIE_GIT_AUTHOR_NAME = "Magpie Bot";
    process.env.MAGPIE_GIT_AUTHOR_EMAIL = "bot@example.com";
  });

  it("the leftover state really does break a naive retry", async () => {
    const { clonePath } = await initBareRemoteWithClone();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "markdown-magpie-worktree-"));
    await git(clonePath, ["worktree", "add", "-B", BRANCH, path.join(tempRoot, "checkout"), "origin/main"]);
    await assert.rejects(
      () => git(clonePath, ["worktree", "add", "-B", BRANCH, path.join(tempRoot, "again"), "origin/main"]),
      /already (used by worktree|checked out)/
    );
  });

  for (const keepWorktreeDir of [true, false]) {
    it(`retries cleanly when the dead worktree dir is ${keepWorktreeDir ? "still present" : "gone"}`, async () => {
      const { repository, clonePath, remotePath } = await initBareRemoteWithClone();
      const leftover = await simulateKilledPublish(clonePath, { keepWorktreeDir });

      const published = await new LocalGitProposalPublisher().publish({
        repository,
        branchName: BRANCH,
        title: "docs: topic",
        markdown: "# Topic\n",
        targetPath: "docs/topic.md"
      });

      assert.equal(await git(remotePath, ["rev-parse", BRANCH]), published.commitSha, "the branch was pushed");
      assert.equal(existsSync(path.join(clonePath, ".git", "index.lock")), false, "the stale lock was cleared");
      assert.deepEqual(await registeredWorktrees(clonePath), [], "no worktree stays registered");
      assert.equal(existsSync(leftover), false, "the dead publish's worktree dir is gone");
      const files = await git(remotePath, ["ls-tree", "-r", "--name-only", BRANCH]);
      assert.doesNotMatch(files, /half-written/, "nothing from the dead attempt was published");
    });
  }

  it("leaves another proposal's live worktree alone", async () => {
    const { repository, clonePath } = await initBareRemoteWithClone();
    const otherRoot = await mkdtemp(path.join(tmpdir(), "markdown-magpie-worktree-"));
    const otherWorktree = path.join(otherRoot, "checkout");
    await git(clonePath, ["worktree", "add", "-B", "magpie/other", otherWorktree, "origin/main"]);

    await new LocalGitProposalPublisher().publish({
      repository,
      branchName: BRANCH,
      title: "docs: topic",
      markdown: "# Topic\n",
      targetPath: "docs/topic.md"
    });

    assert.deepEqual(await registeredWorktrees(clonePath), [
      await git(otherWorktree, ["rev-parse", "--show-toplevel"])
    ]);
  });

  it("a retry after a landed push is idempotent: same tip, nothing pushed twice (P25)", async () => {
    const { repository, remotePath } = await initBareRemoteWithClone();
    const publisher = new LocalGitProposalPublisher();
    const request = {
      repository,
      branchName: BRANCH,
      title: "docs: topic",
      markdown: "# Topic\n",
      targetPath: "docs/topic.md"
    };
    const first = await publisher.publish(request);
    const retry = await publisher.publish(request);
    assert.equal(retry.commitSha, first.commitSha);
    assert.equal(retry.noChange, undefined, "an existing branch is reported as published, not as a no-op");
    assert.equal(await git(remotePath, ["rev-list", "--count", BRANCH]), "2", "seed + one proposal commit");
  });

  it("an aborted publish rejects, pushes nothing and leaves no worktree registered", async () => {
    const { repository, clonePath, remotePath } = await initBareRemoteWithClone();
    const controller = new AbortController();
    controller.abort(new Error("job cancelled"));
    await assert.rejects(
      () =>
        new LocalGitProposalPublisher().publish(
          { repository, branchName: BRANCH, title: "docs: topic", markdown: "# T\n", targetPath: "docs/topic.md" },
          { signal: controller.signal }
        ),
      (error: unknown) => error instanceof GitCommandError && error.aborted
    );
    assert.deepEqual(await registeredWorktrees(clonePath), []);
    assert.equal(await git(remotePath, ["branch", "--list", BRANCH]), "");
  });

  it("an abort mid-publish kills git, then the worktree is still cleaned up", async () => {
    const { repository, clonePath, remotePath } = await initBareRemoteWithClone();
    // A pre-commit hook that hangs stands in for a git child stuck mid-publish.
    const hook = path.join(clonePath, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1\n", { mode: 0o755 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("job cancelled")), 500);
    const started = Date.now();
    await assert.rejects(
      () =>
        new LocalGitProposalPublisher().publish(
          { repository, branchName: BRANCH, title: "docs: topic", markdown: "# T\n", targetPath: "docs/topic.md" },
          { signal: controller.signal }
        ),
      (error: unknown) => error instanceof GitCommandError && error.aborted
    );
    assert.ok(Date.now() - started < 20_000, "the abort ended the publish before the hung hook finished");
    assert.deepEqual(await registeredWorktrees(clonePath), []);
    assert.equal(await git(remotePath, ["branch", "--list", BRANCH]), "");
  });
});
