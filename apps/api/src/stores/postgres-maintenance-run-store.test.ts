import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresMaintenanceRunStore } from "./postgres-maintenance-run-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

// Integration tests for the Postgres-backed maintenance-run store. They self-skip
// unless DATABASE_URL points at a migrated database; CI provides one. Assert by the
// ids/flow you created so parallel rows never make the suite flaky.
const databaseUrl = process.env.DATABASE_URL;

describe("PostgresMaintenanceRunStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresMaintenanceRunStore(makeTestPool(databaseUrl as string));

  it("update rewrites a running run's outcome and stamps completed_at when it leaves running", async () => {
    const flowId = `flow-${randomUUID()}`;
    const run = await store.record({
      taskType: "correctness_patrol",
      flowId,
      trigger: "scheduled",
      status: "running",
      summary: "2 verifies in progress",
      details: { pendingVerifies: 2 }
    });
    assert.equal(run.completedAt, undefined);

    const stillRunning = await store.update(run.id, {
      status: "running",
      summary: "1 verify in progress",
      details: { pendingVerifies: 1 }
    });
    assert.equal(stillRunning?.completedAt, undefined);

    const done = await store.update(run.id, {
      status: "completed",
      summary: "checked 2",
      details: { pendingVerifies: 0 }
    });
    assert.equal(done?.status, "completed");
    assert.ok(done?.completedAt);
    assert.equal(done?.flowId, flowId, "identity fields are untouched");
    assert.deepEqual((await store.get(run.id))?.details, { pendingVerifies: 0 });

    assert.equal(await store.update(randomUUID(), { status: "completed", summary: "x", details: {} }), undefined);
  });

  it("records, lists newest-first, filters by task type, and reads one", async () => {
    const flowId = `flow-${randomUUID()}`;
    const older = await store.record({
      taskType: "correctness_patrol",
      flowId,
      trigger: "scheduled",
      status: "completed",
      summary: "older",
      details: { selectedCount: 3 }
    });
    const newer = await store.record({
      taskType: "editorial_patrol",
      flowId,
      trigger: "manual",
      status: "failed",
      summary: "newer",
      error: "boom",
      details: {}
    });

    const forFlow = await store.list({ flowId, limit: 10 });
    assert.deepEqual(
      forFlow.map((r) => r.id),
      [newer.id, older.id]
    );

    const fixOnly = await store.list({ taskType: "correctness_patrol", flowId, limit: 10 });
    assert.deepEqual(
      fixOnly.map((r) => r.id),
      [older.id]
    );

    const fetched = await store.get(older.id);
    assert.equal(fetched?.summary, "older");
    assert.deepEqual(fetched?.details, { selectedCount: 3 });
    assert.equal((await store.get(newer.id))?.error, "boom");
  });
});
