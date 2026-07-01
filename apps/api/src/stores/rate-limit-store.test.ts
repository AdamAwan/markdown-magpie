import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryRateLimitStore, windowStartFor } from "./rate-limit-store.js";

describe("windowStartFor", () => {
  it("anchors timestamps to the start of their fixed window", () => {
    assert.equal(windowStartFor(1_000, 1_000), 1_000);
    assert.equal(windowStartFor(1_999, 1_000), 1_000);
    assert.equal(windowStartFor(2_000, 1_000), 2_000);
  });
});

describe("InMemoryRateLimitStore", () => {
  it("increments within a window and blocks once the limit is exceeded", async () => {
    const store = new InMemoryRateLimitStore();
    const now = 1_000_000;

    const first = await store.hit("k", 60_000, 2, now);
    assert.equal(first.count, 1);
    assert.equal(first.remaining, 1);
    assert.equal(first.allowed, true);
    assert.equal(first.retryAfterMs, 0);

    const second = await store.hit("k", 60_000, 2, now + 10);
    assert.equal(second.count, 2);
    assert.equal(second.allowed, true);

    const third = await store.hit("k", 60_000, 2, now + 20);
    assert.equal(third.count, 3);
    assert.equal(third.allowed, false);
    assert.equal(third.remaining, 0);
    assert.ok(third.retryAfterMs > 0, "blocked hit reports a positive retry delay");
  });

  it("resets the count in a new window", async () => {
    const store = new InMemoryRateLimitStore();
    await store.hit("k", 1_000, 5, 10_000);
    await store.hit("k", 1_000, 5, 10_500);
    const rolledOver = await store.hit("k", 1_000, 5, 12_000);
    assert.equal(rolledOver.count, 1, "a later window starts a fresh count");
  });

  it("keys are independent", async () => {
    const store = new InMemoryRateLimitStore();
    const a = await store.hit("a", 1_000, 1, 0);
    const b = await store.hit("b", 1_000, 1, 0);
    assert.equal(a.count, 1);
    assert.equal(b.count, 1);
  });

  it("prune drops counters from ended windows", async () => {
    const store = new InMemoryRateLimitStore();
    await store.hit("old", 1_000, 5, 1_000);
    await store.hit("new", 1_000, 5, 5_000);
    await store.prune(5_000);
    // "old" window (start 1_000) is < 5_000 and pruned; "new" (start 5_000) stays.
    const oldAfter = await store.hit("old", 1_000, 5, 5_100);
    assert.equal(oldAfter.count, 1, "pruned key starts fresh");
    const newAfter = await store.hit("new", 1_000, 5, 5_100);
    assert.equal(newAfter.count, 2, "unpruned key keeps its count");
  });
});
