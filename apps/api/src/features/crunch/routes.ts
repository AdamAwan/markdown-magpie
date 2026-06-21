import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { apiLink, parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import { reconcileSchedules } from "../../jobs/schedule-reconciler.js";
import * as crunchService from "./service.js";
import { crunchSettingsBodySchema } from "./schema.js";

export function crunchRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/runs", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 20);
    return c.json({ runs: await crunchService.listRuns(ctx, limit) });
  });

  app.post("/run", requireScopes("manage:knowledge"), async (c) => {
    const payload = await readJsonBody<{ flowId?: string }>(c);
    try {
      const run = await crunchService.triggerCrunchRun(ctx, {
        flowId: payload.flowId?.trim() || undefined,
        trigger: "manual"
      });
      // Planning is enqueue-only: the run starts "running" and is completed by the
      // watcher. Return 202 with a status link so the client can poll for the plan.
      return c.json({ run, links: { status: apiLink(`/crunch/runs/${run.id}`) } }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Crunch run failed to start";
      throw new HttpError(500, "crunch_run_failed", message);
    }
  });

  app.get("/settings", requireScopes("read:knowledge"), async (c) =>
    c.json({ settings: await crunchService.settingsForResponse(ctx) })
  );

  app.post(
    "/settings",
    requireScopes("manage:knowledge"),
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
      // Push the saved schedule into pg-boss so the change takes effect without a restart.
      await reconcileSchedules(ctx);
      return c.json({ settings: await crunchService.settingsForResponse(ctx) });
    }
  );

  app.post("/runs/:id/publish", requireScopes("manage:knowledge"), async (c) => {
    // Git execution happens in the Task 7 watcher runner; the API validates the
    // run and repository pre-flight then enqueues. Invalid publishes still fail
    // fast with the original 404/409 codes before any job is created.
    const outcome = await crunchService.publishRun(ctx, c.req.param("id"));
    if (!outcome.ok) {
      throw new HttpError(outcome.status, outcome.code, outcome.message);
    }
    return c.json(
      {
        job: outcome.job,
        links: {
          job: apiLink(`/jobs/${outcome.job.id}`),
          wait: apiLink(`/jobs/${outcome.job.id}/wait`),
          cancel: apiLink(`/jobs/${outcome.job.id}/cancel`)
        }
      },
      202
    );
  });

  // The non-generative execution context the Task 7 publication runner fetches
  // before executing git: the run plus the credential-free repository config.
  app.get("/runs/:id/execution-context", requireScopes("manage:knowledge"), async (c) => {
    const outcome = await crunchService.getRunExecutionContext(ctx, c.req.param("id"));
    if (!outcome.ok) {
      throw new HttpError(outcome.status, outcome.code, outcome.message);
    }
    return c.json({ run: outcome.run, repository: outcome.repository });
  });

  app.get("/runs/:id", requireScopes("read:knowledge"), async (c) => {
    const run = await crunchService.getRun(ctx, c.req.param("id"));
    if (!run) {
      throw new HttpError(404, "crunch_run_not_found");
    }
    return c.json({ run });
  });

  return app;
}
