import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";
import { listScheduledTasks } from "../../scheduling/task-registry.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and we
// can exercise the route shapes directly.

const GAPS_TASK_KEY = "gaps-to-pull-requests::magpie-support";

function contextWithFlow() {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "magpie-support", name: "Magpie Support", sourceIds: [], destinationId: "kb" }];
  return ctx;
}

test("POST /api/scheduled-tasks/:key/run enqueues the task's job and returns 202", async () => {
  const ctx = contextWithFlow();
  const app = buildApp(ctx);

  const res = await app.request(`/api/scheduled-tasks/${GAPS_TASK_KEY}/run`, { method: "POST" });
  assert.equal(res.status, 202);
  const body = (await res.json()) as { job: { id: string; type: string }; links: { job: string } };
  assert.equal(body.job.type, "process_gaps_to_pull_requests");

  const { jobs } = await ctx.jobs.list({ type: "process_gaps_to_pull_requests" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.id, body.job.id);
  assert.deepEqual(jobs[0]!.input, { flowId: "magpie-support" });
});

test("POST /api/scheduled-tasks/:key/run returns 404 for an unknown task", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/scheduled-tasks/does-not-exist/run", { method: "POST" });
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "scheduled_task_not_found");
});

test("POST /api/scheduled-tasks/:key/run refuses a second concurrent run with 409", async () => {
  const ctx = contextWithFlow();
  const app = buildApp(ctx);

  const first = await app.request(`/api/scheduled-tasks/${GAPS_TASK_KEY}/run`, { method: "POST" });
  assert.equal(first.status, 202);

  // The first job is still in flight (created), so a second run is refused.
  const second = await app.request(`/api/scheduled-tasks/${GAPS_TASK_KEY}/run`, { method: "POST" });
  assert.equal(second.status, 409);
  const body = (await second.json()) as { error: string };
  assert.equal(body.error, "already_running");

  // Only the first job exists.
  const { jobs } = await ctx.jobs.list({ type: "process_gaps_to_pull_requests" });
  assert.equal(jobs.length, 1);
});

test("a terminal previous run does not block a new manual run", async () => {
  const ctx = contextWithFlow();
  const app = buildApp(ctx);

  const first = await app.request(`/api/scheduled-tasks/${GAPS_TASK_KEY}/run`, { method: "POST" });
  const firstBody = (await first.json()) as { job: { id: string } };
  // Drive the first job to a terminal state so it no longer counts as in-flight.
  await ctx.jobs.cancel(firstBody.job.id);

  const second = await app.request(`/api/scheduled-tasks/${GAPS_TASK_KEY}/run`, { method: "POST" });
  assert.equal(second.status, 202);
});

test("the registry expands a configured-flow task keyed gaps-to-pull-requests::<flowId>", () => {
  const ctx = contextWithFlow();
  const tasks = listScheduledTasks(ctx);
  const task = tasks.find((t) => t.key === GAPS_TASK_KEY);
  assert.ok(task, "expected a configured-flow gaps task");
  assert.equal(task.jobType, "process_gaps_to_pull_requests");
  assert.deepEqual(task.input, { flowId: "magpie-support" });
});
