import { Hono } from "hono";
import { isValidCron } from "@magpie/core";
import type { JobState } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { apiLink } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import { reconcileSchedules } from "../../jobs/schedule-reconciler.js";
import { findScheduledTask, scheduledTasksForResponse } from "../../scheduling/task-registry.js";

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

export function scheduledTaskRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("read:knowledge"), async (c) => c.json({ tasks: await scheduledTasksForResponse(ctx) }));

  app.post("/:key/settings", requireScopes("manage:jobs"), async (c) => {
    const key = c.req.param("key");
    const task = findScheduledTask(ctx, key);
    if (!task) {
      throw new HttpError(404, "scheduled_task_not_found");
    }

    const payload = await readJsonBody<{ enabled?: boolean; cron?: string }>(c);
    const cron = typeof payload.cron === "string" ? payload.cron.trim() : "";
    if (!isValidCron(cron)) {
      throw new HttpError(
        400,
        "valid_cron_required",
        'cron must be a standard 5-field expression, e.g. "*/10 * * * *".'
      );
    }

    await ctx.stores.scheduledTasks.updateSettings(key, { enabled: Boolean(payload.enabled), cron });
    // Push the saved schedule into pg-boss so the change takes effect without a restart.
    await reconcileSchedules(ctx);
    return c.json({ tasks: await scheduledTasksForResponse(ctx) });
  });

  app.post("/:key/run", requireScopes("manage:jobs"), async (c) => {
    const key = c.req.param("key");
    const task = findScheduledTask(ctx, key);
    if (!task) {
      throw new HttpError(404, "scheduled_task_not_found");
    }

    // A manual run now enqueues the task's registered job for a watcher to execute,
    // exactly as the schedule does — the heavy AI + git work runs off the request
    // thread in a capability-matched watcher, not in-process.
    //
    // Overlap protection (broker-agnostic; pg-boss's `create` exposes no singleton
    // key): refuse a second concurrent run of the SAME task by scanning for an
    // in-flight job of this task's job type whose flow matches, restoring the 409
    // guard 8B had dropped. The match is by type + flowId, so one flow's task is
    // never blocked by another flow's run of the same job type.
    const targetFlowId = inputFlowId(task.input);
    const { jobs: existing } = await ctx.jobs.list({ type: task.jobType, limit: 200 });
    const running = existing.find(
      (job) => IN_FLIGHT_JOB_STATES.has(job.state) && inputFlowId(job.input) === targetFlowId
    );
    if (running) {
      throw new HttpError(409, "already_running", `A ${task.jobType} job for this task is already in flight.`);
    }

    const job = await ctx.jobs.create(task.jobType, task.input);
    return c.json(
      {
        job,
        links: { job: apiLink(`/jobs/${job.id}`), wait: apiLink(`/jobs/${job.id}/wait`) },
        tasks: await scheduledTasksForResponse(ctx)
      },
      202
    );
  });

  return app;
}
