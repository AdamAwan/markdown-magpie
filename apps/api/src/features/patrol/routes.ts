import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as patrolService from "./service.js";

export function fixPatrolRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  // Thin orchestration endpoint the maintenance watcher's correctness_patrol runner POSTs.
  // Selects the next batch of documents to patrol, runs the verify lens over them,
  // advances the cursor, and records a maintenance run with its findings. Body
  // optional; an absent flowId patrols the default (unscoped) flow. (Run history is
  // read via GET /api/maintenance-runs.)
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
      runId: outcome.runId,
      selectedCount: outcome.selectedCount,
      findingCount: outcome.findings.length
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
      runId: outcome.runId,
      selectedCount: outcome.selectedCount,
      enqueuedCount: outcome.enqueuedCount
    });
  });

  return app;
}
