import type { JobState, JobType, JobView } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { reconcileSchedules } from "../../jobs/schedule-reconciler.js";
import { findScheduledTask, type ScheduledTaskDefinition } from "../../scheduling/task-registry.js";

// A run is "in flight" while it sits in any of these non-terminal states, so a
// second manual run of the same task must not start.
const IN_FLIGHT_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(["created", "active", "retry", "blocked"]);

// A task's run targets one flow; some job inputs carry that flow, others (the `{}`
// inputs) target the default flow. Compare flowIds so a manual run of one flow's
// task is never blocked by another flow's in-flight job of the same type.
function inputFlowId(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const candidate = (input as { flowId?: unknown }).flowId;
  return typeof candidate === "string" ? candidate : undefined;
}

// True when a job of this task's type, targeting this task's flow, is already in
// flight. Overlap protection is broker-agnostic (pg-boss's `create` exposes no
// singleton key): we scan for a non-terminal job whose type and flow match, so one
// flow's task is never blocked by another flow's run of the same job type.
async function isTaskRunning(ctx: AppContext, task: ScheduledTaskDefinition): Promise<boolean> {
  const targetFlowId = inputFlowId(task.input);
  const { jobs } = await ctx.jobs.list({ type: task.jobType, limit: 200 });
  return jobs.some((job) => IN_FLIGHT_JOB_STATES.has(job.state) && inputFlowId(job.input) === targetFlowId);
}

// Outcome of a manual run. `code`s are the API error keys the route maps to a
// status; `already_running` carries the job type so the route can phrase its 409.
export type RunScheduledTaskOutcome =
  | { ok: true; job: JobView }
  | { ok: false; code: "scheduled_task_not_found" }
  | { ok: false; code: "already_running"; jobType: JobType };

// Enqueues the task's registered job for a watcher to execute, exactly as the
// schedule does — the heavy AI + git work runs off the request thread in a
// capability-matched watcher, not in-process. Refuses a second concurrent run of
// the same task (by job type + flow) so a double-click can't fan out duplicate work.
export async function runScheduledTask(ctx: AppContext, key: string): Promise<RunScheduledTaskOutcome> {
  const task = findScheduledTask(ctx, key);
  if (!task) {
    return { ok: false, code: "scheduled_task_not_found" };
  }
  if (await isTaskRunning(ctx, task)) {
    return { ok: false, code: "already_running", jobType: task.jobType };
  }
  const job = await ctx.jobs.create(task.jobType, task.input);
  return { ok: true, job };
}

// Outcome of a settings update. The only failure is an unknown task key.
export type UpdateTaskSettingsOutcome = { ok: true } | { ok: false; code: "scheduled_task_not_found" };

// Persists a task's schedule then pushes it into pg-boss so the change takes effect
// without a restart. The caller has already validated the cron format.
export async function updateTaskSettings(
  ctx: AppContext,
  key: string,
  settings: { enabled: boolean; cron: string }
): Promise<UpdateTaskSettingsOutcome> {
  const task = findScheduledTask(ctx, key);
  if (!task) {
    return { ok: false, code: "scheduled_task_not_found" };
  }
  await ctx.stores.scheduledTasks.updateSettings(key, settings);
  await reconcileSchedules(ctx);
  return { ok: true };
}
