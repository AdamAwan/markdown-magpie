import { Hono } from "hono";
import { isValidCron } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as crunchService from "./service.js";

export function crunchRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/runs", async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 20);
    return c.json({ runs: await crunchService.listRuns(ctx, limit) });
  });

  app.post("/run", async (c) => {
    const payload = await readJsonBody<{ flowId?: string }>(c);
    try {
      const run = await crunchService.triggerCrunchRun(ctx, {
        flowId: payload.flowId?.trim() || undefined,
        trigger: "manual"
      });
      return c.json({ run }, run.status === "failed" ? 502 : 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Crunch run failed to start";
      throw new HttpError(500, "crunch_run_failed", message);
    }
  });

  app.get("/settings", async (c) => c.json({ settings: await crunchService.settingsForResponse(ctx) }));

  app.post("/settings", async (c) => {
    const payload = await readJsonBody<{ flowId?: string; enabled?: boolean; cron?: string }>(c);
    const cron = typeof payload.cron === "string" ? payload.cron.trim() : "";
    if (!isValidCron(cron)) {
      throw new HttpError(400, "valid_cron_required", 'cron must be a standard 5-field expression, e.g. "0 2 * * *".');
    }

    await crunchService.updateSettings(ctx, payload.flowId?.trim() || undefined, {
      enabled: Boolean(payload.enabled),
      cron
    });
    return c.json({ settings: await crunchService.settingsForResponse(ctx) });
  });

  app.post("/runs/:id/publish", async (c) => {
    const outcome = await crunchService.publishRun(ctx, c.req.param("id"));
    if (!outcome.ok) {
      throw new HttpError(outcome.status, outcome.code, outcome.message);
    }
    return c.json({ run: outcome.run, publication: outcome.publication });
  });

  app.get("/runs/:id", async (c) => {
    const run = await crunchService.getRun(ctx, c.req.param("id"));
    if (!run) {
      throw new HttpError(404, "crunch_run_not_found");
    }
    return c.json({ run });
  });

  return app;
}
