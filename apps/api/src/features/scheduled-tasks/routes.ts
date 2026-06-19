import { Hono } from "hono";
import { isValidCron } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import { findScheduledTask, scheduledTasksForResponse } from "../../scheduling/task-registry.js";

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
    return c.json({ tasks: await scheduledTasksForResponse(ctx) });
  });

  app.post("/:key/run", requireScopes("manage:jobs"), async (c) => {
    const key = c.req.param("key");
    const task = findScheduledTask(ctx, key);
    if (!task) {
      throw new HttpError(404, "scheduled_task_not_found");
    }

    // Take the run-lock up front so a manual run can't start alongside a
    // scheduled run, another tab's run, or a run on another instance. A held
    // lock means a run is already in flight, so report 409 rather than piling on.
    const lock = await ctx.stores.scheduledTasks.tryAcquireRun(key, task.defaultCron);
    if (!lock) {
      return c.json(
        {
          ok: false,
          started: false,
          reason: "already_running",
          message: "A run for this side-process is already in progress.",
          tasks: await scheduledTasksForResponse(ctx)
        },
        409
      );
    }

    // A manual run drives the same (potentially long, AI + git) pipeline the
    // scheduler runs. Kick it off the request thread and return 202; the task's
    // effects are observable via the proposals/crunch/source-sync endpoints, and
    // failures are logged by the background runner. The lock is released when the
    // background run settles, win or lose.
    ctx.background.run(`scheduled-task ${key}`, async () => {
      try {
        await task.run(ctx);
      } finally {
        await ctx.stores.scheduledTasks.releaseRun(key);
      }
    });
    return c.json({ ok: true, started: true, tasks: await scheduledTasksForResponse(ctx) }, 202);
  });

  return app;
}
