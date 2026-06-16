import { Hono } from "hono";
import { isValidCron } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import { findScheduledTask, scheduledTasksForResponse } from "../../scheduling/task-registry.js";

export function scheduledTaskRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", async (c) => c.json({ tasks: await scheduledTasksForResponse(ctx) }));

  app.post("/:key/settings", async (c) => {
    const key = c.req.param("key");
    const task = findScheduledTask(key);
    if (!task) {
      throw new HttpError(404, "scheduled_task_not_found");
    }

    const payload = await readJsonBody<{ enabled?: boolean; cron?: string }>(c);
    const cron = typeof payload.cron === "string" ? payload.cron.trim() : "";
    if (!isValidCron(cron)) {
      throw new HttpError(400, "valid_cron_required", 'cron must be a standard 5-field expression, e.g. "*/10 * * * *".');
    }

    await ctx.stores.scheduledTasks.updateSettings(key, { enabled: Boolean(payload.enabled), cron });
    return c.json({ tasks: await scheduledTasksForResponse(ctx) });
  });

  app.post("/:key/run", async (c) => {
    const key = c.req.param("key");
    const task = findScheduledTask(key);
    if (!task) {
      throw new HttpError(404, "scheduled_task_not_found");
    }

    try {
      await task.run(ctx);
      return c.json({ ok: true, tasks: await scheduledTasksForResponse(ctx) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "scheduled task run failed";
      throw new HttpError(500, "scheduled_task_run_failed", message);
    }
  });

  return app;
}
