import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { parseLimit } from "../../platform/paths.js";
import * as gapsService from "./service.js";

export function gapRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/candidates", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json({ gaps: await gapsService.listCandidates(ctx, limit) });
  });

  app.get("/clusters", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json({ clusters: await gapsService.listClusters(ctx, limit) });
  });

  // Run the full gap→PR reconciliation for one flow. This is the thin endpoint the
  // maintenance watcher's process_gaps_to_pull_requests runner POSTs; the heavy
  // orchestration (clustering, the reshape AI job, drafting and publication
  // enqueue) stays in the API. The body is optional; an absent flowId reconciles
  // the default/un-routed flow. Same admin scope as the scheduled-task run route.
  app.post("/reconcile", requireScopes("manage:jobs"), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { flowId?: unknown };
    const flowId = typeof body.flowId === "string" ? body.flowId : undefined;
    await gapsService.reconcileFlow(ctx, flowId);
    return c.json({ ok: true });
  });

  // Manually draft a proposal for one persisted cluster. The body is optional;
  // targetPath/destinationId override the flow's defaults when supplied.
  app.post("/clusters/:id/proposal", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      targetPath?: unknown;
      destinationId?: unknown;
    };
    const outcome = await gapsService.draftFromCluster(ctx, id, {
      targetPath: typeof body.targetPath === "string" ? body.targetPath : undefined,
      destinationId: typeof body.destinationId === "string" ? body.destinationId : undefined
    });
    if (!outcome.ok) {
      return c.json({ error: outcome.code }, 404);
    }
    return c.json(outcome);
  });

  return app;
}
