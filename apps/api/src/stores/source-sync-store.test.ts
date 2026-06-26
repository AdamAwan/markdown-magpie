import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangesetChange, MaintenancePlan } from "@magpie/core";
import { InMemorySourceSyncStore } from "./source-sync-store.js";

const PLAN: MaintenancePlan = { summary: "s", operations: [], rationale: "r" };
const CHANGESET: ChangesetChange[] = [{ path: "guide.md", content: "x" }];

async function runningRun(store: InMemorySourceSyncStore, flowId?: string) {
  return store.createRun({
    flowId,
    sourceId: "src-1",
    trigger: "scheduled",
    status: "running",
    toSha: "head",
    changedFileCount: 1,
    candidateCount: 1
  });
}

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

test("createRun records a terminal run and recordRunPublication marks it published", async () => {
  const store = new InMemorySourceSyncStore();

  const run = await store.createRun({
    flowId: "flow",
    destinationId: "dest",
    sourceId: "src",
    trigger: "scheduled",
    status: "completed",
    plan: { summary: "s", operations: [], rationale: "r" },
    fromSha: "a",
    toSha: "b",
    changedFileCount: 2,
    candidateCount: 1
  });

  assert.equal(run.status, "completed");
  assert.ok(run.completedAt, "a terminal run carries completedAt");

  const published = await store.recordRunPublication(run.id, {
    provider: "local-git",
    branchName: "magpie/source-sync-x",
    commitSha: "deadbeef",
    publishedAt: new Date().toISOString()
  });

  assert.equal(published?.status, "published");
  assert.equal(published?.publication?.branchName, "magpie/source-sync-x");
  assert.equal((await store.getRun(run.id))?.status, "published");
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

test("deferRun moves a running run to deferred and preserves plan + changeset", async () => {
  const store = new InMemorySourceSyncStore();
  const run = await runningRun(store);
  const deferred = await store.deferRun(run.id, PLAN, CHANGESET);
  assert.equal(deferred?.status, "deferred");
  assert.deepEqual(deferred?.changeset, CHANGESET);
  assert.deepEqual(deferred?.plan, PLAN);
  assert.equal(deferred?.completedAt, undefined);
});

test("deferRun is a no-op on a non-running run", async () => {
  const store = new InMemorySourceSyncStore();
  const run = await runningRun(store);
  await store.completeRun(run.id, PLAN, CHANGESET); // now "completed"
  const deferred = await store.deferRun(run.id, PLAN, CHANGESET);
  assert.equal(deferred?.status, "completed");
});

test("completeDeferredRun moves a deferred run to completed and stamps completedAt", async () => {
  const store = new InMemorySourceSyncStore();
  const run = await runningRun(store);
  await store.deferRun(run.id, PLAN, CHANGESET);
  const completed = await store.completeDeferredRun(run.id);
  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.changeset, CHANGESET);
  assert.ok(completed?.completedAt, "completedAt stamped");
});

test("completeDeferredRun returns the run only for the call that performs the transition", async () => {
  const store = new InMemorySourceSyncStore();
  const run = await runningRun(store);
  await store.deferRun(run.id, PLAN, CHANGESET);

  // The winning call transitions the run and gets it back, so its caller publishes.
  const first = await store.completeDeferredRun(run.id);
  assert.equal(first?.status, "completed");

  // A second (racing) call did nothing, so it returns undefined and its caller skips
  // publication — this is what prevents the double-publish.
  const second = await store.completeDeferredRun(run.id);
  assert.equal(second, undefined);
});

test("completeDeferredRun returns undefined on a non-deferred run", async () => {
  const store = new InMemorySourceSyncStore();
  const run = await runningRun(store); // still "running"
  assert.equal(await store.completeDeferredRun(run.id), undefined);
});

test("completeDeferredRun returns undefined for an unknown id", async () => {
  const store = new InMemorySourceSyncStore();
  assert.equal(await store.completeDeferredRun("missing"), undefined);
});

test("listDeferredRuns returns only deferred runs for the given flow", async () => {
  const store = new InMemorySourceSyncStore();
  const a = await runningRun(store);            // default flow
  const b = await runningRun(store, "flow-x");  // other flow
  const c = await runningRun(store);            // default flow, stays running
  await store.deferRun(a.id, PLAN, CHANGESET);
  await store.deferRun(b.id, PLAN, CHANGESET);
  // c stays running
  const defaultFlow = await store.listDeferredRuns(undefined);
  assert.deepEqual(defaultFlow.map((r) => r.id), [a.id]);
  const flowX = await store.listDeferredRuns("flow-x");
  assert.deepEqual(flowX.map((r) => r.id), [b.id]);
  assert.equal(c.status, "running");
});
