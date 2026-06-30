import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryMaintenanceRunStore } from "./maintenance-run-store.js";

test("records and lists runs newest-first, filtered by task type and flow", async () => {
  const store = new InMemoryMaintenanceRunStore();
  const a = await store.record({
    taskType: "correctness_patrol",
    flowId: "f1",
    trigger: "scheduled",
    status: "completed",
    summary: "a",
    details: {}
  });
  await store.record({
    taskType: "editorial_patrol",
    flowId: "f1",
    trigger: "scheduled",
    status: "completed",
    summary: "b",
    details: {}
  });
  const c = await store.record({
    taskType: "correctness_patrol",
    trigger: "manual",
    status: "failed",
    summary: "c",
    error: "boom",
    details: {}
  });

  const all = await store.list({ limit: 10 });
  assert.deepEqual(all.map((r) => r.summary), ["c", "b", "a"]);

  const fix = await store.list({ taskType: "correctness_patrol", limit: 10 });
  assert.deepEqual(fix.map((r) => r.summary), ["c", "a"]);

  const f1 = await store.list({ flowId: "f1", limit: 10 });
  assert.deepEqual(f1.map((r) => r.summary), ["b", "a"]);

  assert.equal((await store.get(a.id))?.summary, "a");
  assert.equal((await store.get(c.id))?.error, "boom");
  assert.ok((await store.get(a.id))?.completedAt, "terminal run has completedAt");
});

test("limit caps the list", async () => {
  const store = new InMemoryMaintenanceRunStore();
  for (let i = 0; i < 5; i += 1) {
    await store.record({ taskType: "correctness_patrol", trigger: "scheduled", status: "completed", summary: `r${i}`, details: {} });
  }
  assert.equal((await store.list({ limit: 3 })).length, 3);
});
