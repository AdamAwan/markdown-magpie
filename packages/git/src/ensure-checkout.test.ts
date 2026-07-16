import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { ensureGitCheckout } from "./index.js";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]): Promise<string> => exec("git", args, { cwd }).then((r) => r.stdout.trim());

async function initBareRemote(): Promise<{ root: string; remotePath: string; seedClone: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-ensure-test-"));
  const remotePath = path.join(root, "remote.git");
  const seedClone = path.join(root, "seed");
  await mkdir(remotePath, { recursive: true });
  await git(remotePath, ["init", "--bare", "--initial-branch=main"]);
  await exec("git", ["clone", remotePath, seedClone]);
  await git(seedClone, ["config", "user.name", "Seed"]);
  await git(seedClone, ["config", "user.email", "seed@example.com"]);
  await writeFile(path.join(seedClone, "README.md"), "# seed\n", "utf8");
  await git(seedClone, ["add", "-A"]);
  await git(seedClone, ["commit", "-m", "seed"]);
  await git(seedClone, ["push", "-u", "origin", "main"]);
  return { root, remotePath, seedClone };
}

describe("ensureGitCheckout sync", () => {
  it("reconciles a diverged local checkout to origin instead of failing to fast-forward", async () => {
    const { root, remotePath, seedClone } = await initBareRemote();
    const checkoutRoot = path.join(root, "checkouts");

    // First call clones the checkout.
    const { localPath } = await ensureGitCheckout({ id: "repo", url: remotePath, checkoutRoot, branch: "main" });
    await git(localPath, ["config", "user.name", "Bot"]);
    await git(localPath, ["config", "user.email", "bot@example.com"]);

    // Advance origin/main from the seed clone.
    await writeFile(path.join(seedClone, "upstream.md"), "# upstream\n", "utf8");
    await git(seedClone, ["add", "-A"]);
    await git(seedClone, ["commit", "-m", "upstream change"]);
    await git(seedClone, ["push", "origin", "main"]);
    const originSha = await git(seedClone, ["rev-parse", "HEAD"]);

    // Diverge the local checkout with a commit that is not an ancestor of origin,
    // so `pull --ff-only` cannot fast-forward.
    await writeFile(path.join(localPath, "local.md"), "# local\n", "utf8");
    await git(localPath, ["add", "-A"]);
    await git(localPath, ["commit", "-m", "local divergent change"]);

    // Second call must reconcile the working tree to origin, not abort.
    await ensureGitCheckout({ id: "repo", url: remotePath, checkoutRoot, branch: "main" });

    const headSha = await git(localPath, ["rev-parse", "HEAD"]);
    assert.equal(headSha, originSha, "checkout HEAD matches origin/main after sync");
  });
});
