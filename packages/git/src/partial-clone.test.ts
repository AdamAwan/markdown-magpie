import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { diffChangedFiles, ensureGitCheckout, getHeadSha } from "./index.js";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]): Promise<string> =>
  exec("git", args, { cwd }).then((r) => r.stdout.trim());

// Builds a bare remote with two commits on `main` so a range diff is available,
// and returns the two shas plus the remote path.
async function initBareRemoteWithHistory(): Promise<{
  root: string;
  remotePath: string;
  firstSha: string;
  secondSha: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-partial-clone-"));
  const remotePath = path.join(root, "remote.git");
  const seedClone = path.join(root, "seed");
  await mkdir(remotePath, { recursive: true });
  await git(remotePath, ["init", "--bare", "--initial-branch=main"]);
  await exec("git", ["clone", remotePath, seedClone]);
  await git(seedClone, ["config", "user.name", "Seed"]);
  await git(seedClone, ["config", "user.email", "seed@example.com"]);

  await writeFile(path.join(seedClone, "rules.md"), "limit is 2024\n", "utf8");
  await writeFile(path.join(seedClone, "untouched.md"), "stable\n", "utf8");
  await git(seedClone, ["add", "-A"]);
  await git(seedClone, ["commit", "-m", "first"]);
  const firstSha = await git(seedClone, ["rev-parse", "HEAD"]);

  await writeFile(path.join(seedClone, "rules.md"), "limit is 2025\n", "utf8");
  await git(seedClone, ["add", "-A"]);
  await git(seedClone, ["commit", "-m", "bump"]);
  const secondSha = await git(seedClone, ["rev-parse", "HEAD"]);

  await git(seedClone, ["push", "-u", "origin", "main"]);
  return { root, remotePath, firstSha, secondSha };
}

describe("ensureGitCheckout blobless partial clone", () => {
  const previousToggle = process.env.GIT_PARTIAL_CLONE;
  afterEach(() => {
    if (previousToggle === undefined) {
      delete process.env.GIT_PARTIAL_CLONE;
    } else {
      process.env.GIT_PARTIAL_CLONE = previousToggle;
    }
  });

  it("clones as a blobless partial clone yet still resolves the full commit graph", async () => {
    delete process.env.GIT_PARTIAL_CLONE; // default on
    const { root, remotePath, firstSha, secondSha } = await initBareRemoteWithHistory();
    try {
      const checkoutRoot = path.join(root, "checkouts");
      const { localPath } = await ensureGitCheckout({ id: "src", url: remotePath, checkoutRoot, branch: "main" });

      // The clone recorded the blob:none promisor filter (i.e. it is a partial clone).
      const filter = await git(localPath, ["config", "--get", "remote.origin.partialclonefilter"]);
      assert.equal(filter, "blob:none", "remote configured as a blobless partial clone");

      // The FULL commit graph is present even though blobs were deferred, so the
      // range last_sha..HEAD resolves both commits.
      assert.equal(await getHeadSha(localPath), secondSha);
      assert.equal(await git(localPath, ["rev-parse", `${firstSha}^{commit}`]), firstSha);
      assert.equal(await git(localPath, ["rev-parse", "HEAD~1"]), firstSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("diffs a range whose old-side blobs are not local, exercising the lazy-fetch path", async () => {
    delete process.env.GIT_PARTIAL_CLONE; // default on
    const { root, remotePath, firstSha, secondSha } = await initBareRemoteWithHistory();
    try {
      const checkoutRoot = path.join(root, "checkouts");
      const { localPath } = await ensureGitCheckout({ id: "src", url: remotePath, checkoutRoot, branch: "main" });

      // A blobless clone only fetched the blobs needed to check out HEAD; the OLD
      // blob of rules.md at firstSha is not local. diffChangedFiles must trigger an
      // on-demand fetch and still return the correct per-file diff.
      const { changes, totalCount } = await diffChangedFiles(localPath, firstSha, secondSha);
      assert.equal(totalCount, 1);
      const rules = changes.find((c) => c.path === "rules.md");
      assert.ok(rules, "rules.md reported as changed");
      assert.equal(rules?.status, "modified");
      assert.match(rules?.diff ?? "", /-limit is 2024/);
      assert.match(rules?.diff ?? "", /\+limit is 2025/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to a normal (non-partial) clone when partial clone is disabled", async () => {
    process.env.GIT_PARTIAL_CLONE = "0";
    const { root, remotePath, secondSha } = await initBareRemoteWithHistory();
    try {
      const checkoutRoot = path.join(root, "checkouts");
      const { localPath } = await ensureGitCheckout({ id: "src", url: remotePath, checkoutRoot, branch: "main" });

      assert.ok(existsSync(path.join(localPath, ".git")), "a working checkout exists");
      // No partial-clone filter is configured on a plain clone.
      const filter = await git(localPath, ["config", "--get", "remote.origin.partialclonefilter"]).catch(() => "");
      assert.equal(filter, "", "no partial-clone filter on the fallback clone");
      assert.equal(await getHeadSha(localPath), secondSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-syncs an existing checkout to origin (reset behavior unchanged)", async () => {
    delete process.env.GIT_PARTIAL_CLONE;
    const { root, remotePath } = await initBareRemoteWithHistory();
    try {
      const checkoutRoot = path.join(root, "checkouts");
      const { localPath } = await ensureGitCheckout({ id: "src", url: remotePath, checkoutRoot, branch: "main" });

      // Advance origin/main, then a second ensureGitCheckout must bring the working
      // tree to the new tip (proving fetch+reset still work over a partial clone).
      const seedClone = path.join(root, "seed");
      await writeFile(path.join(seedClone, "rules.md"), "limit is 2026\n", "utf8");
      await git(seedClone, ["add", "-A"]);
      await git(seedClone, ["commit", "-m", "bump again"]);
      await git(seedClone, ["push", "origin", "main"]);
      const originSha = await git(seedClone, ["rev-parse", "HEAD"]);

      await ensureGitCheckout({ id: "src", url: remotePath, checkoutRoot, branch: "main" });
      assert.equal(await getHeadSha(localPath), originSha, "checkout advanced to origin tip");
      assert.equal((await git(localPath, ["show", "HEAD:rules.md"])).trim(), "limit is 2026");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
