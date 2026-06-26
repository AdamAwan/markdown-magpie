import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as patrolService from "./service.js";

export function fixPatrolRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/runs", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 20);
    return c.json({ runs: await patrolService.listRuns(ctx, limit) });
  });

  // Thin orchestration endpoint the maintenance watcher's fix_patrol runner POSTs.
  // Selects the next batch of documents to patrol, runs the verify lens over them,
  // advances the cursor, and records the run with its findings. Body optional; an
  // absent flowId patrols the default (unscoped) flow.
  app.post("/run", requireScopes("manage:jobs"), async (c) => {
    const payload = await readJsonBody<{ flowId?: string }>(c);
    const outcome = await patrolService.runFixPatrol(ctx, {
      flowId: payload.flowId?.trim() || undefined,
      trigger: "scheduled"
    });
    if (!outcome.ok) {
      throw new HttpError(400, outcome.code);
    }
    return c.json({
      runId: outcome.run.id,
      selectedCount: outcome.run.selectedCount,
      findingCount: outcome.run.findings.length
    });
  });

  app.post("/improve/run", requireScopes("manage:jobs"), async (c) => {
    const payload = await readJsonBody<{ flowId?: string }>(c);
    const outcome = await patrolService.runImprovePatrol(ctx, {
      flowId: payload.flowId?.trim() || undefined,
      trigger: "scheduled"
    });
    if (!outcome.ok) {
      throw new HttpError(400, outcome.code);
    }
    return c.json({
      runId: outcome.run.id,
      selectedCount: outcome.run.selectedCount,
      enqueuedCount: outcome.enqueuedCount
    });
  });
  app.get("/runs/:id", requireScopes("read:knowledge"), async (c) => {
    const run = await patrolService.getRun(ctx, c.req.param("id"));
    if (!run) {
      throw new HttpError(404, "patrol_run_not_found");
    }
    return c.json({ run });
  });

  return app;
}
