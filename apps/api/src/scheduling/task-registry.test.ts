import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { findScheduledTask, listScheduledTasks } from "./task-registry.js";

test("with no flows configured, no flow-scoped tasks are registered", () => {
  const ctx = makeTestContext(); // knowledgeConfig.flows is []

  const tasks = listScheduledTasks(ctx);
  assert.equal(tasks.length, 0);

  // The old un-suffixed, default, and separate-refresh keys are gone.
  assert.equal(findScheduledTask(ctx, "gaps-to-pull-requests"), undefined, "tasks are per-flow, never un-suffixed");
  assert.equal(
    findScheduledTask(ctx, "gaps-to-pull-requests::default"),
    undefined,
    "there is no synthetic default flow"
  );
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

test("a local-git flow is not offered the github-only snapshot-refresh (PR poll) task", () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.destinations = [
    { id: "local", name: "Local", url: "file:///tmp/demo-repo", kind: "git" },
    { id: "hosted", name: "Hosted", url: "https://github.com/o/r.git", kind: "git" }
  ];
  ctx.knowledgeConfig.flows = [
    { id: "local-flow", name: "Local", sourceIds: [], destinationId: "local" },
    { id: "hosted-flow", name: "Hosted", sourceIds: [], destinationId: "hosted" }
  ];

  // The local flow keeps the reconcile/publish + patrol tasks (four templates) but
  // drops snapshot-refresh; the hosted flow keeps all five.
  assert.equal(findScheduledTask(ctx, "snapshot-refresh::local-flow"), undefined, "no PR poll for a local-git flow");
  assert.ok(findScheduledTask(ctx, "snapshot-refresh::hosted-flow"), "the hosted flow still polls PRs");
  assert.ok(findScheduledTask(ctx, "gaps-to-pull-requests::local-flow"), "the local flow still reconciles/publishes");
  assert.ok(findScheduledTask(ctx, "fix-patrol::local-flow"), "the local flow still patrols");
  assert.equal(listScheduledTasks(ctx).length, 4 + 5, "local flow: 4 tasks, hosted flow: 5 tasks");
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

test("the fix-patrol task queues the correctness_patrol job with the flow in its input", () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "alpha", name: "Alpha", sourceIds: [], destinationId: "kb" }];
  const patrol = findScheduledTask(ctx, "fix-patrol::alpha");
  assert.ok(patrol, "a fix-patrol task is registered");
  assert.equal(patrol!.baseKey, "fix-patrol");
  assert.equal(patrol!.jobType, "correctness_patrol");
  assert.deepEqual(patrol!.input, { flowId: "alpha" });
});

test("the improve-patrol task queues the editorial_patrol job with the flow in its input", () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "alpha", name: "Alpha", sourceIds: [], destinationId: "kb" }];
  const patrol = findScheduledTask(ctx, "improve-patrol::alpha");
  assert.ok(patrol, "an improve-patrol task is registered");
  assert.equal(patrol!.baseKey, "improve-patrol");
  assert.equal(patrol!.jobType, "editorial_patrol");
  assert.deepEqual(patrol!.input, { flowId: "alpha" });
  // Its human-facing label says Editorial, distinct from the Correctness patrol task.
  assert.match(patrol!.typeLabel, /Editorial patrol/);
});
