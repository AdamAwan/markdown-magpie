import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { apiLink, parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as crunchService from "./service.js";
import { crunchSettingsBodySchema } from "./schema.js";

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
      // Planning happens off the request thread; the run starts "running" and is
      // completed in the background (direct) or by the watcher (queue). Return
      // 202 with a status link so the client can poll for the plan.
      if (run.status === "running") {
        return c.json({ run, links: { status: apiLink(`/crunch/runs/${run.id}`) } }, 202);
      }
      return c.json({ run }, run.status === "failed" ? 502 : 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Crunch run failed to start";
      throw new HttpError(500, "crunch_run_failed", message);
    }
  });

  app.get("/settings", async (c) => c.json({ settings: await crunchService.settingsForResponse(ctx) }));

  app.post(
    "/settings",
    zValidator("json", crunchSettingsBodySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "valid_cron_required", message: 'cron must be a standard 5-field expression, e.g. "0 2 * * *".' },
          400
        );
      }
    }),
    async (c) => {
      const { flowId, enabled, cron } = c.req.valid("json");

      await crunchService.updateSettings(ctx, flowId?.trim() || undefined, {
        enabled: Boolean(enabled),
        cron
      });
      return c.json({ settings: await crunchService.settingsForResponse(ctx) });
    }
  );

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
