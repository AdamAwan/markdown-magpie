import { Hono } from "hono";
import { isValidCron } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { apiLink } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import { scheduledTasksForResponse } from "../../scheduling/task-registry.js";
import * as service from "./service.js";

export function scheduledTaskRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("read:knowledge"), async (c) => c.json({ tasks: await scheduledTasksForResponse(ctx) }));

  app.post("/:key/settings", requireScopes("manage:jobs"), async (c) => {
    const payload = await readJsonBody<{ enabled?: boolean; cron?: string }>(c);
    const cron = typeof payload.cron === "string" ? payload.cron.trim() : "";
    if (!isValidCron(cron)) {
      throw new HttpError(
        400,
        "valid_cron_required",
        'cron must be a standard 5-field expression, e.g. "*/10 * * * *".'
      );
    }

    const outcome = await service.updateTaskSettings(ctx, c.req.param("key"), {
      enabled: Boolean(payload.enabled),
      cron
    });
    if (!outcome.ok) {
      throw new HttpError(404, outcome.code);
    }
    return c.json({ tasks: await scheduledTasksForResponse(ctx) });
  });

  app.post("/:key/run", requireScopes("manage:jobs"), async (c) => {
    const outcome = await service.runScheduledTask(ctx, c.req.param("key"));
    if (!outcome.ok) {
      if (outcome.code === "already_running") {
        throw new HttpError(409, outcome.code, `A ${outcome.jobType} job for this task is already in flight.`);
      }
      throw new HttpError(404, outcome.code);
    }

    const { job } = outcome;
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
