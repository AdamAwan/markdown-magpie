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

test("listRuns returns most recent first and reset clears everything", async () => {
  const store = new InMemorySourceSyncStore();
  await store.setState("flow", "src", "sha");
  await store.createRun({ sourceId: "src", trigger: "manual", status: "skipped", toSha: "b", changedFileCount: 1, candidateCount: 0 });

  assert.equal((await store.listRuns(10)).length, 1);

  await store.reset();
  assert.equal((await store.listRuns(10)).length, 0);
  assert.equal(await store.getState("flow", "src"), undefined);
});
