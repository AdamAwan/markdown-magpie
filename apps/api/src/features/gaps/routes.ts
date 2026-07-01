import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { HttpError } from "../../http/errors.js";
import { parseLimit } from "../../platform/paths.js";
import * as gapsService from "./service.js";
import { draftFromClusterBodySchema, reconcileBodySchema } from "./schema.js";

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

  // Run the full gap→PR reconciliation for one configured flow. This is the thin
  // endpoint the maintenance watcher's process_gaps_to_pull_requests runner POSTs;
  // the heavy orchestration (clustering, the reshape AI job, drafting and
  // publication enqueue) stays in the API. Same admin scope as the scheduled-task
  // run route.
  app.post(
    "/reconcile",
    requireScopes("manage:jobs"),
    zValidator("json", reconcileBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "flow_id_required" }, 400);
      }
    }),
    async (c) => {
      const { flowId } = c.req.valid("json");
      if (!ctx.knowledgeConfig.flows.some((flow) => flow.id === flowId)) {
        throw new HttpError(404, "flow_not_found");
      }
      await gapsService.reconcileFlow(ctx, flowId);
      return c.json({ ok: true });
    }
  );

  // Manually draft a proposal for one persisted cluster. The body is optional;
  // targetPath/destinationId override the flow's defaults when supplied.
  app.post(
    "/clusters/:id/proposal",
    requireScopes("manage:knowledge"),
    zValidator("json", draftFromClusterBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid_proposal_overrides" }, 400);
      }
    }),
    async (c) => {
      const id = c.req.param("id");
      const { targetPath, destinationId } = c.req.valid("json");
      const outcome = await gapsService.draftFromCluster(ctx, id, { targetPath, destinationId });
      if (!outcome.ok) {
        return c.json({ error: outcome.code }, 404);
      }
      return c.json(outcome);
    }
  );

  return app;
}
