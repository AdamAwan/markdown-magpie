import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { clearStaleGitLocks, cloneStagingPrefix, removeStaleCloneStaging } from "./checkout-repair.js";

async function fakeCheckout(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-repair-"));
  await mkdir(path.join(root, ".git"), { recursive: true });
  return root;
}

async function age(filePath: string, msAgo: number): Promise<void> {
  const when = new Date(Date.now() - msAgo);
  await utimes(filePath, when, when);
}

describe("clearStaleGitLocks", () => {
  it("removes a lock older than the staleness bound and keeps a fresh one", async () => {
    const checkout = await fakeCheckout();
    const stale = path.join(checkout, ".git", "index.lock");
    const fresh = path.join(checkout, ".git", "HEAD.lock");
    await writeFile(stale, "");
    await writeFile(fresh, "");
    await age(stale, 60_000);

    const removed = await clearStaleGitLocks(checkout, { maxAgeMs: 30_000 });

    assert.deepEqual(removed, [stale]);
    assert.equal(existsSync(stale), false, "the stale lock left by a killed git is gone");
    assert.equal(existsSync(fresh), true, "a young lock may belong to a live git and is kept");
  });

  it("defaults the staleness bound to twice the git subprocess timeout", async () => {
    const checkout = await fakeCheckout();
    const lock = path.join(checkout, ".git", "index.lock");
    await writeFile(lock, "");
    await age(lock, 60_000);
    // GIT_TIMEOUT_MS defaults to 120 s, so a one-minute-old lock is still live.
    assert.deepEqual(await clearStaleGitLocks(checkout), []);
    await age(lock, 5 * 60_000);
    assert.deepEqual(await clearStaleGitLocks(checkout), [lock]);
  });

  it("is a no-op for a directory that is not a checkout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "magpie-repair-"));
    assert.deepEqual(await clearStaleGitLocks(dir), []);
  });
});

describe("removeStaleCloneStaging", () => {
  it("removes only this checkout's staging dirs, and only once they are older than a live clone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "magpie-staging-"));
    const old = path.join(root, `${cloneStagingPrefix("docs")}aaaaaa`);
    const young = path.join(root, `${cloneStagingPrefix("docs")}bbbbbb`);
    const other = path.join(root, `${cloneStagingPrefix("other")}cccccc`);
    for (const dir of [old, young, other]) {
      await mkdir(path.join(dir, ".git"), { recursive: true });
    }
    await age(old, 10_000);
    await age(other, 10_000);

    const removed = await removeStaleCloneStaging(root, "docs", { maxAgeMs: 5_000 });

    assert.deepEqual(removed, [old]);
    assert.equal(existsSync(young), true, "a young staging dir may be a clone still running elsewhere");
    assert.equal(existsSync(other), true, "another checkout's staging is never touched");
  });
});
