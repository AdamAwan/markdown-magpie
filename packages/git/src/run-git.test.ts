import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { GitCommandError, git, tryGit } from "./run-git.js";

// `git hash-object --stdin` blocks reading stdin, which execFile leaves open: a
// deterministic stand-in for a git child that hangs (stalled network, prompt).
const HANGING = ["hash-object", "--stdin"];

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "magpie-run-git-"));
}

describe("git runner", () => {
  it("kills the git child when the signal aborts and rejects as aborted", async () => {
    const cwd = await tempDir();
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error("job cancelled")), 100);
    await assert.rejects(
      () => git(cwd, HANGING, { signal: controller.signal, timeoutMs: 30_000 }),
      (error: unknown) => {
        assert.ok(error instanceof GitCommandError);
        assert.equal(error.aborted, true);
        assert.match(error.message, /job cancelled/);
        return true;
      }
    );
    assert.ok(Date.now() - started < 10_000, "the abort ended the call well before the timeout");
  });

  it("never starts git for an already-aborted signal, and tryGit does not swallow the abort", async () => {
    const cwd = await tempDir();
    const controller = new AbortController();
    controller.abort(new Error("shutting down"));
    await assert.rejects(() => tryGit(cwd, ["--version"], { signal: controller.signal }), /aborted: shutting down/);
  });

  it("reports a timeout distinctly", async () => {
    const cwd = await tempDir();
    await assert.rejects(
      () => git(cwd, HANGING, { timeoutMs: 200 }),
      (error: unknown) => {
        assert.ok(error instanceof GitCommandError);
        assert.equal(error.timedOut, true);
        assert.match(error.message, /timed out after 200ms/);
        return true;
      }
    );
  });

  it("redacts credentials from the error message built from argv and stderr", async () => {
    const cwd = await tempDir();
    await assert.rejects(
      () => git(cwd, ["ls-remote", "--", "https://x-access-token:ghp_secret@127.0.0.1:9/a/b.git"]),
      (error: unknown) => {
        assert.ok(error instanceof GitCommandError);
        assert.doesNotMatch(error.message, /ghp_secret/);
        assert.match(error.message, /https:\/\/\*\*\*@127\.0\.0\.1/);
        assert.equal(error.cause, undefined, "the raw execFile error (with unredacted cmd) is not attached");
        return true;
      }
    );
  });
});
