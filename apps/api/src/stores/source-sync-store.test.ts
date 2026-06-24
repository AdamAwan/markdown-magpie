import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangesetChange, CrunchPlan } from "@magpie/core";
import { InMemorySourceSyncStore } from "./source-sync-store.js";

const PLAN: CrunchPlan = { summary: "s", operations: [], rationale: "r" };
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

test("completeDeferredRun is a no-op on a non-deferred run", async () => {
  const store = new InMemorySourceSyncStore();
  const run = await runningRun(store); // still "running"
  const result = await store.completeDeferredRun(run.id);
  assert.equal(result?.status, "running");
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
