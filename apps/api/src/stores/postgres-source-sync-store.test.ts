import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresSourceSyncStore } from "./postgres-source-sync-store.js";
import type { SourceSyncRunInput } from "./source-sync-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

// Integration tests for the Postgres-backed source sync store. They self-skip
// unless DATABASE_URL points at a migrated database (see scripts/migrate.mjs);
// CI provides one via a pgvector service container. This is the template to
// follow for the other Postgres* stores — round-trip through real SQL and
// assert by the ids you created so parallel rows never make the suite flaky.
const databaseUrl = process.env.DATABASE_URL;

function draftRun(sourceId: string): SourceSyncRunInput {
  return {
    sourceId,
    trigger: "manual",
    status: "completed",
    toSha: "abc123",
    changedFileCount: 1,
    candidateCount: 0
  };
}

describe("PostgresSourceSyncStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresSourceSyncStore(makeTestPool(databaseUrl as string));

  it("round-trips state through setState and getState", async () => {
    const flowId = `flow-${randomUUID()}`;
    const sourceId = `src-${randomUUID()}`;
    const lastSha = "def456";

    const created = await store.setState(flowId, sourceId, lastSha);
    assert.equal(created.flowId, flowId);
    assert.equal(created.sourceId, sourceId);
    assert.equal(created.lastSha, lastSha);
    assert.ok(created.lastCheckedAt, "lastCheckedAt should be stamped");

    const fetched = await store.getState(flowId, sourceId);
    assert.equal(fetched?.flowId, flowId);
    assert.equal(fetched?.sourceId, sourceId);
    assert.equal(fetched?.lastSha, lastSha);
  });

  it("upserts state when called again with the same flow and source", async () => {
    const flowId = `flow-${randomUUID()}`;
    const sourceId = `src-${randomUUID()}`;

    await store.setState(flowId, sourceId, "sha1");
    const second = await store.setState(flowId, sourceId, "sha2");

    assert.equal(second.lastSha, "sha2");
    assert.ok(second.lastCheckedAt);
    assert.equal((await store.getState(flowId, sourceId))?.lastSha, "sha2");
  });

  it("tracks state separately for the default flow (undefined flowId)", async () => {
    const sourceId = `src-${randomUUID()}`;

    await store.setState(`flow-a`, sourceId, "sha-a");
    await store.setState(undefined, sourceId, "sha-default");

    assert.equal((await store.getState(`flow-a`, sourceId))?.lastSha, "sha-a");
    assert.equal((await store.getState(undefined, sourceId))?.lastSha, "sha-default");
  });

  it("round-trips a run through createRun and getRun", async () => {
    const sourceId = `src-${randomUUID()}`;
    const input = draftRun(sourceId);

    const created = await store.createRun(input);
    assert.equal(created.sourceId, sourceId);
    assert.equal(created.trigger, "manual");
    assert.equal(created.status, "completed");
    assert.equal(created.toSha, "abc123");
    assert.ok(created.completedAt, "a terminal run should have completedAt stamped");

    const fetched = await store.getRun(created.id);
    assert.equal(fetched?.id, created.id);
    assert.equal(fetched?.sourceId, sourceId);
    assert.equal(fetched?.toSha, created.toSha);
  });

  it("listRuns returns runs sorted by most recent first", async () => {
    const sourceId = `src-${randomUUID()}`;

    const run1 = await store.createRun(draftRun(sourceId));
    const run2 = await store.createRun(draftRun(sourceId));

    const runs = await store.listRuns(100);
    const runIds = runs.map((r) => r.id);

    assert.ok(runIds.includes(run1.id), "first run should appear in the list");
    assert.ok(runIds.includes(run2.id), "second run should appear in the list");
    // Most recent first: run2 should appear before run1
    const run2Index = runIds.indexOf(run2.id);
    const run1Index = runIds.indexOf(run1.id);
    assert.ok(run2Index < run1Index, "most recent run should appear first");
  });

  it("respects the limit parameter in listRuns", async () => {
    const sourceId = `src-${randomUUID()}`;

    await store.createRun(draftRun(sourceId));
    await store.createRun(draftRun(sourceId));
    await store.createRun(draftRun(sourceId));

    const runs = await store.listRuns(1);
    assert.equal(runs.length, 1, "listRuns should respect the limit");
  });

  it("returns undefined when getting a non-existent run", async () => {
    assert.equal(await store.getRun("00000000-0000-0000-0000-000000000000"), undefined);
  });

  it("stores optional fields and round-trips them", async () => {
    const sourceId = `src-${randomUUID()}`;
    const flowId = `flow-${randomUUID()}`;
    const destinationId = `dest-${randomUUID()}`;
    const jobId = `job-${randomUUID()}`;
    const plan = { summary: "Test plan", operations: [], rationale: "For testing" };

    const run = await store.createRun({
      flowId,
      destinationId,
      sourceId,
      trigger: "scheduled",
      status: "completed",
      jobId,
      plan,
      fromSha: "oldsha",
      toSha: "newsha",
      changedFileCount: 5,
      candidateCount: 2,
      error: undefined
    });

    const fetched = await store.getRun(run.id);
    assert.equal(fetched?.flowId, flowId);
    assert.equal(fetched?.destinationId, destinationId);
    assert.equal(fetched?.jobId, jobId);
    assert.equal(fetched?.fromSha, "oldsha");
    assert.deepEqual(fetched?.plan, plan);
  });

  it("links a running run by jobId and completeRun stamps the changeset once", async () => {
    const sourceId = `src-${randomUUID()}`;
    const jobId = `job-${randomUUID()}`;
    const running = await store.createRun({
      sourceId,
      trigger: "scheduled",
      status: "running",
      jobId,
      toSha: "head",
      changedFileCount: 1,
      candidateCount: 1
    });
    assert.equal((await store.getRunByJobId(jobId))?.id, running.id);

    const plan = { summary: "s", operations: [], rationale: "r" };
    const changeset = [{ path: "guide.md", content: "x" }];
    const completed = await store.completeRun(running.id, plan, changeset);
    assert.equal(completed?.status, "completed");
    assert.deepEqual(completed?.changeset, changeset);
    assert.ok(completed?.completedAt);

    // Idempotent: a terminal run is not regressed by a late failure.
    assert.equal((await store.failRun(running.id, "late"))?.status, "completed");
  });

  it("markSkipped and failRun transition only a running run", async () => {
    const plan = { summary: "s", operations: [], rationale: "r" };

    const skip = await store.createRun({
      sourceId: `src-${randomUUID()}`,
      trigger: "scheduled",
      status: "running",
      jobId: `job-${randomUUID()}`,
      toSha: "head",
      changedFileCount: 1,
      candidateCount: 1
    });
    const skipped = await store.markSkipped(skip.id, plan);
    assert.equal(skipped?.status, "skipped");
    assert.ok(skipped?.plan);

    const fail = await store.createRun({
      sourceId: `src-${randomUUID()}`,
      trigger: "scheduled",
      status: "running",
      jobId: `job-${randomUUID()}`,
      toSha: "head",
      changedFileCount: 1,
      candidateCount: 1
    });
    const failed = await store.failRun(fail.id, "boom");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, "boom");
  });

  it("handles running status without completedAt", async () => {
    const sourceId = `src-${randomUUID()}`;

    const running = await store.createRun({
      sourceId,
      trigger: "manual",
      status: "running",
      toSha: "sha",
      changedFileCount: 0,
      candidateCount: 0
    });

    assert.equal(running.status, "running");
    assert.equal(running.completedAt, undefined, "running status should not have completedAt");

    const fetched = await store.getRun(running.id);
    assert.equal(fetched?.completedAt, undefined);
  });
});
