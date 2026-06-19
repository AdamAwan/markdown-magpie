import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { findScheduledTask, listScheduledTasks } from "./task-registry.js";

test("with no flows configured, each task expands to a single default-flow instance", () => {
  const ctx = makeTestContext(); // knowledgeConfig.flows is []

  const tasks = listScheduledTasks(ctx);
  assert.equal(tasks.length, 2, "one gaps task + one source-sync task for the default flow");

  const reconciler = findScheduledTask(ctx, "gaps-to-pull-requests::default");
  assert.ok(reconciler, "the default-flow reconciler is registered");
  assert.equal(reconciler!.defaultCron, "*/10 * * * *");
  assert.ok(findScheduledTask(ctx, "source-change-sync::default"), "the default-flow source sync is registered");

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
  assert.equal(tasks.length, 4, "two templates × two flows");

  for (const flowId of ["alpha", "beta"]) {
    assert.ok(findScheduledTask(ctx, `gaps-to-pull-requests::${flowId}`), `gaps task exists for ${flowId}`);
    assert.ok(findScheduledTask(ctx, `source-change-sync::${flowId}`), `source sync exists for ${flowId}`);
  }

  // Labels name the flow so the per-flow controls are distinguishable in the UI.
  assert.match(findScheduledTask(ctx, "gaps-to-pull-requests::alpha")!.label, /Alpha/);
});
