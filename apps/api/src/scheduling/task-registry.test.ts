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

test("each configured flow gets its own instance of every per-flow task", () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "alpha", name: "Alpha", sourceIds: [], destinationId: "kb" },
    { id: "beta", name: "Beta", sourceIds: [], destinationId: "kb" }
  ];

  const tasks = listScheduledTasks(ctx);
  assert.equal(tasks.length, 11, "five per-flow templates × two flows, plus the all-flows snapshot refresh");

  for (const flowId of ["alpha", "beta"]) {
    assert.ok(findScheduledTask(ctx, `gaps-to-pull-requests::${flowId}`), `gaps task exists for ${flowId}`);
    assert.ok(findScheduledTask(ctx, `source-change-sync::${flowId}`), `source sync exists for ${flowId}`);
    assert.equal(findScheduledTask(ctx, `snapshot-refresh::${flowId}`), undefined, "snapshot refresh is not per-flow");
    assert.ok(findScheduledTask(ctx, `fix-patrol::${flowId}`), `fix patrol exists for ${flowId}`);
    assert.ok(findScheduledTask(ctx, `improve-patrol::${flowId}`), `improve patrol exists for ${flowId}`);
    assert.ok(findScheduledTask(ctx, `seed-bootstrap::${flowId}`), `seed bootstrap exists for ${flowId}`);
  }

  // Labels name the flow so the per-flow controls are distinguishable in the UI.
  assert.match(findScheduledTask(ctx, "gaps-to-pull-requests::alpha")!.label, /Alpha/);
});

test("snapshot refresh is one all-flows task, since a single run polls every flow's PRs", () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "alpha", name: "Alpha", sourceIds: [], destinationId: "kb" },
    { id: "beta", name: "Beta", sourceIds: [], destinationId: "kb" }
  ];

  const refreshes = listScheduledTasks(ctx).filter((task) => task.baseKey === "snapshot-refresh");
  assert.equal(refreshes.length, 1, "scheduled once, not once per flow");
  const [refresh] = refreshes;
  assert.equal(refresh.key, "snapshot-refresh::all");
  assert.equal(refresh.flowId, undefined, "an all-flows task belongs to no single flow");
  assert.equal(refresh.jobType, "refresh_flow_snapshot");
  assert.deepEqual(refresh.input, {});
  assert.match(refresh.label, /All flows/);
});

test("a local-git flow gets no per-flow PR work, and the PR poll needs a GitHub flow", () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.destinations = [
    { id: "local", name: "Local", url: "file:///tmp/demo-repo", kind: "git" },
    { id: "hosted", name: "Hosted", url: "https://github.com/o/r.git", kind: "git" }
  ];
  ctx.knowledgeConfig.flows = [
    { id: "local-flow", name: "Local", sourceIds: [], destinationId: "local" },
    { id: "hosted-flow", name: "Hosted", sourceIds: [], destinationId: "hosted" }
  ];

  // Both flows keep the five per-flow tasks; the hosted flow is what keeps the
  // single all-flows PR poll registered.
  assert.ok(findScheduledTask(ctx, "snapshot-refresh::all"), "a GitHub flow keeps the PR poll registered");
  assert.ok(findScheduledTask(ctx, "gaps-to-pull-requests::local-flow"), "the local flow still reconciles/publishes");
  assert.ok(findScheduledTask(ctx, "fix-patrol::local-flow"), "the local flow still patrols");
  assert.equal(listScheduledTasks(ctx).length, 5 + 5 + 1, "five per flow, plus the PR poll");

  // With only local-git flows there are no pull requests to poll at all.
  ctx.knowledgeConfig.flows = [{ id: "local-flow", name: "Local", sourceIds: [], destinationId: "local" }];
  assert.equal(findScheduledTask(ctx, "snapshot-refresh::all"), undefined, "no PR poll without a GitHub flow");
  assert.equal(listScheduledTasks(ctx).length, 5);
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
