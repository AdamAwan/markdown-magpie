import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { findScheduledTask, listScheduledTasks } from "./task-registry.js";

test("with no flows configured, each task expands to a single default-flow instance", () => {
  const ctx = makeTestContext(); // knowledgeConfig.flows is []

  const tasks = listScheduledTasks(ctx);
  assert.equal(
    tasks.length,
    5,
    "gaps + source-sync + snapshot-refresh + fix-patrol + improve-patrol for the default flow"
  );

  const reconciler = findScheduledTask(ctx, "gaps-to-pull-requests::default");
  assert.ok(reconciler, "the default-flow reconciler is registered");
  assert.equal(reconciler!.defaultCron, "*/10 * * * *");
  assert.ok(findScheduledTask(ctx, "source-change-sync::default"), "the default-flow source sync is registered");
  assert.ok(findScheduledTask(ctx, "snapshot-refresh::default"), "the default-flow snapshot fetch is registered");
  assert.ok(findScheduledTask(ctx, "fix-patrol::default"), "the default-flow fix patrol is registered");
  assert.ok(findScheduledTask(ctx, "improve-patrol::default"), "the default-flow improve patrol is registered");

  // The old un-suffixed and separate-refresh keys are gone.
  assert.equal(findScheduledTask(ctx, "gaps-to-pull-requests"), undefined, "tasks are per-flow, never un-suffixed");
  assert.equal(findScheduledTask(ctx, "pull-request-refresh"), undefined, "the separate refresh task stays removed");
});

test("each configured flow gets its own per-flow instance of every task", () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "alpha", name: "Alpha", sourceIds: [], destinationId: "kb" },
    { id: "beta", name: "Beta", sourceIds: [], destinationId: "kb" }
  ];

  const tasks = listScheduledTasks(ctx);
  assert.equal(tasks.length, 10, "five templates × two flows");

  for (const flowId of ["alpha", "beta"]) {
    assert.ok(findScheduledTask(ctx, `gaps-to-pull-requests::${flowId}`), `gaps task exists for ${flowId}`);
    assert.ok(findScheduledTask(ctx, `source-change-sync::${flowId}`), `source sync exists for ${flowId}`);
    assert.ok(findScheduledTask(ctx, `snapshot-refresh::${flowId}`), `snapshot fetch exists for ${flowId}`);
    assert.ok(findScheduledTask(ctx, `fix-patrol::${flowId}`), `fix patrol exists for ${flowId}`);
    assert.ok(findScheduledTask(ctx, `improve-patrol::${flowId}`), `improve patrol exists for ${flowId}`);
  }

  // Labels name the flow so the per-flow controls are distinguishable in the UI.
  assert.match(findScheduledTask(ctx, "gaps-to-pull-requests::alpha")!.label, /Alpha/);
});

test("the gaps-to-pull-requests task queues the reconciler job with the flow in its input", () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "alpha", name: "Alpha", sourceIds: [], destinationId: "kb" }];

  const reconciler = findScheduledTask(ctx, "gaps-to-pull-requests::alpha");
  assert.ok(reconciler, "a gaps-to-pull-requests task is registered");
  assert.equal(reconciler!.baseKey, "gaps-to-pull-requests");
  assert.equal(reconciler!.jobType, "process_gaps_to_pull_requests");
  assert.deepEqual(reconciler!.input, { flowId: "alpha" });
});

test("the fix-patrol task queues the fix_patrol job with the flow in its input", () => {
  const ctx = makeTestContext();
  const patrol = findScheduledTask(ctx, "fix-patrol::default");
  assert.ok(patrol, "a fix-patrol task is registered");
  assert.equal(patrol!.baseKey, "fix-patrol");
  assert.equal(patrol!.jobType, "fix_patrol");
  assert.deepEqual(patrol!.input, { flowId: undefined });
});

test("the improve-patrol task queues the improve_patrol job with the flow in its input", () => {
  const ctx = makeTestContext();
  const patrol = findScheduledTask(ctx, "improve-patrol::default");
  assert.ok(patrol, "an improve-patrol task is registered");
  assert.equal(patrol!.baseKey, "improve-patrol");
  assert.equal(patrol!.jobType, "improve_patrol");
  assert.deepEqual(patrol!.input, { flowId: undefined });
  // Its human-facing label says Improve, distinct from the Fix patrol task.
  assert.match(patrol!.typeLabel, /Improve patrol/);
});
