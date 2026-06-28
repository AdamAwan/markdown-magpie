import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemorySourceSyncStore } from "./source-sync-store.js";

test("state is tracked per (flow, source) and the default flow is its own row", async () => {
  const store = new InMemorySourceSyncStore();

  await store.setState("flow-a", "src", "sha1");
  await store.setState(undefined, "src", "sha2");

  assert.equal((await store.getState("flow-a", "src"))?.lastSha, "sha1");
  assert.equal((await store.getState(undefined, "src"))?.lastSha, "sha2");
  assert.equal(await store.getState("flow-b", "src"), undefined);
});

test("setState upserts the last commit and stamps lastCheckedAt", async () => {
  const store = new InMemorySourceSyncStore();

  await store.setState("flow", "src", "old");
  const updated = await store.setState("flow", "src", "new");

  assert.equal(updated.lastSha, "new");
  assert.ok(updated.lastCheckedAt, "lastCheckedAt should be stamped");
  assert.equal((await store.getState("flow", "src"))?.lastSha, "new");
});

test("getRunByJobId finds a running run and completeRun stamps the changeset once", async () => {
  const store = new InMemorySourceSyncStore();
  const running = await store.createRun({
    sourceId: "src",
    trigger: "scheduled",
    status: "running",
    jobId: "job-1",
    fromSha: "a",
    toSha: "b",
    changedFileCount: 1,
    candidateCount: 1
  });

  assert.equal(running.status, "running");
  assert.equal(running.completedAt, undefined, "a running run has no completedAt");
  assert.equal((await store.getRunByJobId("job-1"))?.id, running.id);

  const plan = { summary: "s", operations: [], rationale: "r" };
  const changeset = [{ path: "guide.md", content: "x" }];
  const completed = await store.completeRun(running.id, plan, changeset);
  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.changeset, changeset);
  assert.ok(completed?.completedAt, "a completed run is stamped");

  // Idempotent: a terminal run is never regressed by a late failure/skip.
  assert.equal((await store.failRun(running.id, "late"))?.status, "completed");
  assert.equal((await store.markSkipped(running.id, plan))?.status, "completed");
});

test("markSkipped and failRun transition only a running run", async () => {
  const store = new InMemorySourceSyncStore();
  const plan = { summary: "s", operations: [], rationale: "r" };

  const skip = await store.createRun({ sourceId: "s", trigger: "scheduled", status: "running", jobId: "j2", toSha: "b", changedFileCount: 1, candidateCount: 1 });
  const skipped = await store.markSkipped(skip.id, plan);
  assert.equal(skipped?.status, "skipped");
  assert.ok(skipped?.plan, "skipped run keeps the plan it considered");

  const fail = await store.createRun({ sourceId: "s", trigger: "scheduled", status: "running", jobId: "j3", toSha: "b", changedFileCount: 1, candidateCount: 1 });
  const failed = await store.failRun(fail.id, "boom");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "boom");
});

test("listRuns returns most recent first and reset clears everything", async () => {
  const store = new InMemorySourceSyncStore();
  await store.setState("flow", "src", "sha");
  await store.createRun({ sourceId: "src", trigger: "manual", status: "skipped", toSha: "b", changedFileCount: 1, candidateCount: 0 });

  assert.equal((await store.listRuns(10)).length, 1);

  await store.reset();
  assert.equal((await store.listRuns(10)).length, 0);
  assert.equal(await store.getState("flow", "src"), undefined);
});

