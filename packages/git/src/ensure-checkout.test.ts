import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { withCheckoutLock } from "./checkout-lock.js";
import { ensureGitCheckout, GitCommandError } from "./index.js";

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

  it("syncs through a stale index.lock left by a killed git (IN42)", async () => {
    const { root, remotePath } = await initBareRemote();
    const checkoutRoot = path.join(root, "checkouts");
    const { localPath } = await ensureGitCheckout({ id: "repo", url: remotePath, checkoutRoot, branch: "main" });
    const lock = path.join(localPath, ".git", "index.lock");
    await writeFile(lock, "");
    const longAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(lock, longAgo, longAgo);

    await ensureGitCheckout({ id: "repo", url: remotePath, checkoutRoot, branch: "main" });
    assert.equal(existsSync(lock), false);
  });
});

describe("ensureGitCheckout first clone (IN43)", () => {
  it("leaves nothing at the checkout path when the clone fails, so a retry starts clean", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "magpie-ensure-test-"));
    const checkoutRoot = path.join(root, "checkouts");
    await assert.rejects(ensureGitCheckout({ id: "repo", url: path.join(root, "missing.git"), checkoutRoot }), /clone/);
    assert.deepEqual(await readdir(checkoutRoot), [], "no half-written checkout and no staging dir remain");
  });

  it("sweeps staging left by a killed clone, then clones into place", async () => {
    const { root, remotePath } = await initBareRemote();
    const checkoutRoot = path.join(root, "checkouts");
    const leftover = path.join(checkoutRoot, ".repo.clone-dead00");
    await mkdir(path.join(leftover, ".git"), { recursive: true });
    const longAgo = new Date(Date.now() - 24 * 60 * 60_000);
    await utimes(leftover, longAgo, longAgo);

    const { localPath } = await ensureGitCheckout({ id: "repo", url: remotePath, checkoutRoot, branch: "main" });

    assert.deepEqual(await readdir(checkoutRoot), ["repo"]);
    assert.ok(await git(localPath, ["rev-parse", "HEAD"]));
    assert.equal(await git(localPath, ["remote", "get-url", "origin"]), remotePath);
  });

  it("clones into an existing empty directory but refuses a non-empty non-checkout one", async () => {
    const { root, remotePath } = await initBareRemote();
    const checkoutRoot = path.join(root, "checkouts");
    await mkdir(path.join(checkoutRoot, "repo"), { recursive: true });
    await ensureGitCheckout({ id: "repo", url: remotePath, checkoutRoot });
    assert.ok(existsSync(path.join(checkoutRoot, "repo", "README.md")));

    await mkdir(path.join(checkoutRoot, "busy"), { recursive: true });
    await writeFile(path.join(checkoutRoot, "busy", "notes.txt"), "keep me\n", "utf8");
    await assert.rejects(ensureGitCheckout({ id: "busy", url: remotePath, checkoutRoot }), /not empty/);
    assert.ok(existsSync(path.join(checkoutRoot, "busy", "notes.txt")), "nothing of the operator's was removed");
  });

  it("rejects promptly on abort while another operation holds the checkout", async () => {
    const { root, remotePath } = await initBareRemote();
    const checkoutRoot = path.join(root, "checkouts");
    const { localPath } = await ensureGitCheckout({ id: "repo", url: remotePath, checkoutRoot });
    let release: () => void = () => undefined;
    const held = withCheckoutLock(localPath, () => new Promise<void>((resolve) => (release = resolve)));

    const controller = new AbortController();
    const pending = ensureGitCheckout({ id: "repo", url: remotePath, checkoutRoot, signal: controller.signal });
    controller.abort(new Error("job cancelled"));
    await assert.rejects(pending, (error: unknown) => error instanceof GitCommandError && error.aborted);
    release();
    await held;
  });
});

describe("ensureGitCheckout credential hygiene (TM36–TM38)", () => {
  // Port 9 (discard) refuses the connection at once: the network step fails fast
  // and offline, after the checkout's stored remote has been handled.
  const CREDENTIALED = "https://x-access-token:ghp_secret@127.0.0.1:9/acme/docs.git";
  const CLEAN = "https://127.0.0.1:9/acme/docs.git";

  it("never hands git (or its error text) the embedded credential on a first clone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "magpie-ensure-test-"));
    const checkoutRoot = path.join(root, "checkouts");
    await assert.rejects(ensureGitCheckout({ id: "docs", url: CREDENTIALED, checkoutRoot }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /ghp_secret/);
      return true;
    });
    assert.deepEqual(await readdir(checkoutRoot), []);
  });

  it("scrubs a credential an older version stored as origin, and reports the clean url", async () => {
    const { root, remotePath } = await initBareRemote();
    const checkoutRoot = path.join(root, "checkouts");
    const { localPath } = await ensureGitCheckout({ id: "docs", url: remotePath, checkoutRoot });
    // What a pre-fix clone of a credential-embedded url left in .git/config.
    await git(localPath, ["remote", "set-url", "origin", CREDENTIALED]);

    await assert.rejects(ensureGitCheckout({ id: "docs", url: CREDENTIALED, checkoutRoot }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /ghp_secret/);
      return true;
    });
    assert.equal(await git(localPath, ["remote", "get-url", "origin"]), CLEAN);
    const config = await readFile(path.join(localPath, ".git", "config"), "utf8");
    assert.doesNotMatch(config, /ghp_secret/);
  });

  it("names a foreign remote without its credential", async () => {
    const { root, remotePath } = await initBareRemote();
    const checkoutRoot = path.join(root, "checkouts");
    const { localPath } = await ensureGitCheckout({ id: "docs", url: remotePath, checkoutRoot });
    await git(localPath, ["remote", "set-url", "origin", "https://u:ghp_other@github.com/else/where.git"]);
    await assert.rejects(ensureGitCheckout({ id: "docs", url: CLEAN, checkoutRoot }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /already points at https:\/\/github\.com\/else\/where\.git/);
      assert.doesNotMatch(error.message, /ghp_other/);
      return true;
    });
  });

  it("refuses a credential embedded in a plain-http url", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "magpie-ensure-test-"));
    await assert.rejects(
      ensureGitCheckout({ id: "docs", url: "http://bot:hunter2@git.example.com/docs.git", checkoutRoot: root }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /plain http/);
        assert.doesNotMatch(error.message, /hunter2/);
        return true;
      }
    );
  });
});
