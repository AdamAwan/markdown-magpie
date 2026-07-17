import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { assertAllowedGitUrl, ensureGitCheckout } from "./index.js";

const exec = promisify(execFile);

// The dangerous transports #285 protects against: `ext::sh -c …` is git's
// remote-helper transport, which runs an arbitrary command (RCE on the watcher);
// `--upload-pack=…` is a `-`-prefixed value git misreads as an option (argument
// injection); `git://` is the unauthenticated git protocol, outside the allowlist.
const REJECTED_URLS = [
  "ext::sh -c 'touch /tmp/magpie-pwned'",
  "--upload-pack=touch /tmp/magpie-pwned",
  "-oProxyCommand=touch /tmp/magpie-pwned",
  "git://internal.example.com/repo.git",
  "fd::17/repo"
];

describe("assertAllowedGitUrl", () => {
  it("rejects RCE / argument-injection / disallowed-transport URLs", () => {
    for (const url of REJECTED_URLS) {
      assert.throws(() => assertAllowedGitUrl(url), new RegExp("git checkout url", "i"), `expected rejection: ${url}`);
    }
  });

  it("accepts the allowlisted transports and forms real config uses", () => {
    // https/ssh/scp-like/file:// and bare local paths are all legitimate config
    // shapes (see isGitUrl). file:// stays permitted because local-git
    // destinations and local git sources are cloned as file:// repos.
    for (const url of [
      "https://github.com/owner/repo.git",
      "http://internal.example.com/repo.git",
      "ssh://git@github.com/owner/repo.git",
      "git@github.com:owner/repo.git",
      "file:///srv/knowledge/repo.git",
      "/srv/knowledge/repo.git"
    ]) {
      assert.doesNotThrow(() => assertAllowedGitUrl(url), `expected acceptance: ${url}`);
    }
  });
});

describe("ensureGitCheckout url guard (cloneCheckout)", () => {
  it("refuses a clone for every disallowed transport before spawning git", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "magpie-url-guard-"));
    try {
      const checkoutRoot = path.join(root, "checkouts");
      await mkdir(checkoutRoot, { recursive: true });
      for (const url of REJECTED_URLS) {
        await assert.rejects(
          ensureGitCheckout({ id: "evil", url, checkoutRoot }),
          new RegExp("git checkout url", "i"),
          `expected clone rejection: ${url}`
        );
      }
      // The marker an RCE payload would have created must not exist.
      assert.equal(existsSync("/tmp/magpie-pwned"), false, "no command ran");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clones a bare local path with GIT_ALLOW_PROTOCOL enforced", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "magpie-url-guard-ok-"));
    try {
      const remotePath = path.join(root, "remote.git");
      await mkdir(remotePath, { recursive: true });
      await exec("git", ["init", "--bare", "--initial-branch=main"], { cwd: remotePath });
      const seed = path.join(root, "seed");
      await exec("git", ["clone", remotePath, seed]);
      await exec("git", ["-C", seed, "config", "user.email", "seed@example.com"]);
      await exec("git", ["-C", seed, "config", "user.name", "Seed"]);
      await exec("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"]);
      await exec("git", ["-C", seed, "push", "-u", "origin", "main"]);

      const checkoutRoot = path.join(root, "checkouts");
      // A bare local path is git's file transport; it must still succeed with the
      // allowlist enforced (file is permitted).
      const { localPath } = await ensureGitCheckout({ id: "src", url: remotePath, checkoutRoot, branch: "main" });
      assert.ok(existsSync(path.join(localPath, ".git")), "a working checkout exists");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
