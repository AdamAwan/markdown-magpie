import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan } from "../../auth/capabilities.js";
import { HttpError } from "../../http/errors.js";
import { outlineFlowSeed, seedFlow } from "./service.js";
import { outlineBodySchema, seedBodySchema } from "./schema.js";

// Seed a flow with initial content: draft one document per item straight into a
// proposal → PR, bypassing the demand-driven gap pipeline. Same admin scope as the
// gap reconcile route; a role-aware principal needs `manage` on the target flow.
export function seedRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post(
    "/:flowId/seed",
    requireScopes("manage:jobs"),
    zValidator("json", seedBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid_seed_body" }, 400);
      }
    }),
    async (c) => {
      const flowId = c.req.param("flowId");
      if (!ctx.knowledgeConfig.flows.some((flow) => flow.id === flowId)) {
        throw new HttpError(404, "flow_not_found");
      }
      // Seeding drafts and enqueues publications into this flow's KB.
      assertCan(ctx, c, "manage", flowId);
      const { items } = c.req.valid("json");
      const outcome = await seedFlow(ctx, flowId, items);
      if (!outcome.ok) {
        throw new HttpError(outcome.code === "flow_not_found" ? 404 : 400, outcome.code);
      }
      return c.json({ ok: true, jobIds: outcome.jobIds });
    }
  );

  // Propose a seed plan for the flow: enqueue the source-grounded planning job
  // (no topic — the agent explores the flow's sources and plans the whole flow).
  // Enqueue-only: returns the job id; the persisted plan lands via the job's
  // completion handler and is reviewed on the Seed page.
  app.post(
    "/:flowId/outline",
    requireScopes("manage:jobs"),
    zValidator("json", outlineBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid_outline_body" }, 400);
      }
    }),
    async (c) => {
      const flowId = c.req.param("flowId");
      if (!ctx.knowledgeConfig.flows.some((flow) => flow.id === flowId)) {
        throw new HttpError(404, "flow_not_found");
      }
      // Outlining reads the flow's KB and enqueues a job scoped to it.
      assertCan(ctx, c, "manage", flowId);
      const { notes } = c.req.valid("json");
      const outcome = await outlineFlowSeed(ctx, flowId, { notes, origin: "manual" });
      if (!outcome.ok) {
        throw new HttpError(outcome.code === "flow_not_found" ? 404 : 400, outcome.code);
      }
      return c.json({ ok: true, jobId: outcome.jobId, reused: outcome.reused });
    }
  );

  return app;
}
