import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../../test-support/context.js";
import { runScheduledTask, updateTaskSettings } from "./service.js";

// A concrete per-flow task key the registry expands; see scheduling/task-registry.ts.
const GAPS_TASK_KEY = "gaps-to-pull-requests::magpie-support";

function contextWithFlow() {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "magpie-support", name: "Magpie Support", sourceIds: [], destinationId: "kb" }];
  return ctx;
}

test("runScheduledTask enqueues the task's job for its flow", async () => {
  const ctx = contextWithFlow();

  const outcome = await runScheduledTask(ctx, GAPS_TASK_KEY);

  assert.equal(outcome.ok, true);
  assert.ok(outcome.ok && outcome.job.type === "process_gaps_to_pull_requests");
  const { jobs } = await ctx.jobs.list({ type: "process_gaps_to_pull_requests" });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0]!.input, { flowId: "magpie-support" });
});

test("runScheduledTask reports an unknown task without enqueuing", async () => {
  const ctx = makeTestContext();

  const outcome = await runScheduledTask(ctx, "does-not-exist");

  assert.deepEqual(outcome, { ok: false, code: "scheduled_task_not_found" });
});

test("runScheduledTask refuses a second concurrent run of the same task", async () => {
  const ctx = contextWithFlow();
  await runScheduledTask(ctx, GAPS_TASK_KEY);

  const outcome = await runScheduledTask(ctx, GAPS_TASK_KEY);

  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.code === "already_running");
  assert.ok(!outcome.ok && outcome.code === "already_running" && outcome.jobType === "process_gaps_to_pull_requests");
  // Only the first run's job exists.
  const { jobs } = await ctx.jobs.list({ type: "process_gaps_to_pull_requests" });
  assert.equal(jobs.length, 1);
});

test("runScheduledTask allows a new run once the prior run reaches a terminal state", async () => {
  const ctx = contextWithFlow();
  const first = await runScheduledTask(ctx, GAPS_TASK_KEY);
  assert.ok(first.ok);
  // Drive the first job to a terminal state so it no longer counts as in-flight.
  await ctx.jobs.cancel(first.job.id);

  const second = await runScheduledTask(ctx, GAPS_TASK_KEY);

  assert.equal(second.ok, true);
});

test("updateTaskSettings persists a task's schedule", async () => {
  const ctx = contextWithFlow();

  const outcome = await updateTaskSettings(ctx, GAPS_TASK_KEY, { enabled: true, cron: "*/15 * * * *" });

  assert.deepEqual(outcome, { ok: true });
  const stored = await ctx.stores.scheduledTasks.listSettings();
  const saved = stored.find((setting) => setting.key === GAPS_TASK_KEY);
  assert.equal(saved?.enabled, true);
  assert.equal(saved?.cron, "*/15 * * * *");
});

test("updateTaskSettings reports an unknown task", async () => {
  const ctx = makeTestContext();

  const outcome = await updateTaskSettings(ctx, "does-not-exist", { enabled: true, cron: "*/15 * * * *" });

  assert.deepEqual(outcome, { ok: false, code: "scheduled_task_not_found" });
});
