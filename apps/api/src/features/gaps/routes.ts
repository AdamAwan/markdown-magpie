import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan, can } from "../../auth/capabilities.js";
import { HttpError } from "../../http/errors.js";
import { parseLimit } from "../../platform/paths.js";
import * as gapsService from "./service.js";
import { draftFromClusterBodySchema, reconcileBodySchema } from "./schema.js";

export function gapRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/candidates", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    // Gap candidates carry the flow whose questions surfaced them; a role-aware
    // principal only sees candidates for flows it can read.
    const gaps = (await gapsService.listCandidates(ctx, limit)).filter((gap) => can(ctx, c, "read", gap.flowId));
    return c.json({ gaps });
  });

  app.get("/clusters", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    const clusters = (await gapsService.listClusters(ctx, limit)).filter((cluster) =>
      can(ctx, c, "read", cluster.flowId)
    );
    return c.json({ clusters });
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
      // Reconciliation drafts and enqueues publications into this flow's KB.
      assertCan(ctx, c, "manage", flowId);
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

      // A cluster the caller can't read is reported as not-found (its own service
      // code) so clusters in other flows aren't enumerable; drafting from it then
      // requires `manage` on the cluster's flow.
      const cluster = await ctx.stores.gapClusters.getCluster(id);
      if (!cluster || cluster.status !== "active" || !can(ctx, c, "read", cluster.flowId)) {
        return c.json({ error: "cluster_not_found" }, 404);
      }
      assertCan(ctx, c, "manage", cluster.flowId);

      const outcome = await gapsService.draftFromCluster(ctx, id, { targetPath, destinationId });
      if (!outcome.ok) {
        return c.json({ error: outcome.code }, 404);
      }
      return c.json(outcome);
    }
  );

  return app;
}
