import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTransientGitLockError, withGitRetry } from "./git-retry.js";

describe("isTransientGitLockError", () => {
  it("matches git lock-contention messages", () => {
    assert.ok(isTransientGitLockError("could not lock config file .git/config: File exists"));
    assert.ok(isTransientGitLockError("fatal: Unable to create '/repo/.git/index.lock': File exists"));
    assert.ok(isTransientGitLockError("cannot lock ref 'refs/heads/main'"));
  });

  it("does not match unrelated git errors", () => {
    assert.equal(isTransientGitLockError("Not possible to fast-forward, aborting."), false);
    assert.equal(isTransientGitLockError("Proposal does not change docs/x.md"), false);
  });
});

describe("withGitRetry", () => {
  it("retries a transient lock error and then succeeds", async () => {
    let attempts = 0;
    const result = await withGitRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("could not lock config file .git/config: File exists");
        }
        return "ok";
      },
      { attempts: 3, backoffMs: 0 }
    );
    assert.equal(result, "ok");
    assert.equal(attempts, 3);
  });

  it("does not retry a non-lock error", async () => {
    let attempts = 0;
    await assert.rejects(
      withGitRetry(
        async () => {
          attempts += 1;
          throw new Error("Not possible to fast-forward, aborting.");
        },
        { attempts: 3, backoffMs: 0 }
      ),
      /fast-forward/
    );
    assert.equal(attempts, 1);
  });

  it("gives up after the attempt limit", async () => {
    let attempts = 0;
    await assert.rejects(
      withGitRetry(
        async () => {
          attempts += 1;
          throw new Error("Unable to create 'index.lock': File exists");
        },
        { attempts: 3, backoffMs: 0 }
      ),
      /index\.lock/
    );
    assert.equal(attempts, 3);
  });
});
