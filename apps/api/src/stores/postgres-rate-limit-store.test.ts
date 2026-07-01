import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresRateLimitStore } from "./postgres-rate-limit-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

// Integration tests for the Postgres-backed rate-limit counter. They self-skip
// unless DATABASE_URL points at a migrated database (migration 0036 creates
// rate_limit_counters). Unique bucket keys keep parallel rows from making the
// suite flaky.
const databaseUrl = process.env.DATABASE_URL;

describe("PostgresRateLimitStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresRateLimitStore(makeTestPool(databaseUrl as string));

  it("atomically increments within a window and blocks over the limit", async () => {
    const key = `test-${randomUUID()}`;
    const now = 1_700_000_000_000;

    const first = await store.hit(key, 60_000, 2, now);
    assert.equal(first.count, 1);
    assert.equal(first.allowed, true);

    const second = await store.hit(key, 60_000, 2, now + 10);
    assert.equal(second.count, 2);
    assert.equal(second.allowed, true);

    const third = await store.hit(key, 60_000, 2, now + 20);
    assert.equal(third.count, 3);
    assert.equal(third.allowed, false);
    assert.ok(third.retryAfterMs > 0);
  });

  it("resets in a new window and drops the key's stale rows", async () => {
    const key = `test-${randomUUID()}`;
    const now = 1_700_000_100_000;

    await store.hit(key, 1_000, 5, now);
    await store.hit(key, 1_000, 5, now + 100);
    const rolledOver = await store.hit(key, 1_000, 5, now + 5_000);
    assert.equal(rolledOver.count, 1, "a later window starts a fresh count");

    // The stale window row is deleted by the UPSERT's DELETE CTE, so the key has
    // exactly one row: re-hitting the original window starts fresh rather than
    // resuming the old count.
    const oldWindowAgain = await store.hit(key, 1_000, 5, now + 200);
    assert.equal(oldWindowAgain.count, 1);
  });

  it("counts concurrent hits without losing increments", async () => {
    const key = `test-${randomUUID()}`;
    const now = 1_700_000_200_000;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.hit(key, 60_000, 100, now))
    );
    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    // 20 concurrent atomic increments must yield exactly the counts 1..20.
    assert.deepEqual(counts, Array.from({ length: 20 }, (_, i) => i + 1));
  });
});
