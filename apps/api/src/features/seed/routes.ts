import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan } from "../../auth/capabilities.js";
import { HttpError } from "../../http/errors.js";
import {
  approveSeedPlan,
  dismissSeedPlan,
  getSeedPlan,
  listSeedPlans,
  outlineFlowSeed,
  patchSeedPlan
} from "./service.js";
import { outlineBodySchema, seedPlanPatchSchema } from "./schema.js";

// Seeding routes mounted under /api/flows: propose a plan for a flow and list
// its plans. Drafting is driven exclusively by plan approval (see
// seedPlanRoutes) — the old raw-items seed endpoint is gone. Same admin scope
// as the gap reconcile route; a role-aware principal needs `manage` on the
// target flow.
export function seedRoutes(ctx: AppContext): Hono {
  const app = new Hono();

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

  // The flow's seed plans, newest first.
  app.get("/:flowId/seed-plans", requireScopes("manage:jobs"), async (c) => {
    const flowId = c.req.param("flowId");
    if (!ctx.knowledgeConfig.flows.some((flow) => flow.id === flowId)) {
      throw new HttpError(404, "flow_not_found");
    }
    assertCan(ctx, c, "manage", flowId);
    return c.json({ plans: await listSeedPlans(ctx, flowId) });
  });

  return app;
}

// Plan-scoped review routes mounted under /api/seed-plans. Every route loads
// the plan first and 404s when missing, THEN authorizes against the plan's
// flow — the cross-flow-as-404 convention holds because unknown ids 404
// before any authz signal.
export function seedPlanRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/:id", requireScopes("manage:jobs"), async (c) => {
    const plan = await getSeedPlan(ctx, c.req.param("id"));
    if (!plan) {
      throw new HttpError(404, "plan_not_found");
    }
    assertCan(ctx, c, "manage", plan.flowId);
    return c.json({ plan });
  });

  // Reviewer edits — charter/persona text, item fields, per-item status. Only
  // while the plan is still proposed; afterwards it reads 409.
  app.patch(
    "/:id",
    requireScopes("manage:jobs"),
    zValidator("json", seedPlanPatchSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid_plan_patch" }, 400);
      }
    }),
    async (c) => {
      const plan = await getSeedPlan(ctx, c.req.param("id"));
      if (!plan) {
        throw new HttpError(404, "plan_not_found");
      }
      assertCan(ctx, c, "manage", plan.flowId);
      const outcome = await patchSeedPlan(ctx, plan.id, c.req.valid("json"));
      if (!outcome.ok) {
        throw new HttpError(outcome.code === "plan_not_found" ? 404 : 409, outcome.code);
      }
      return c.json({ plan: outcome.plan });
    }
  );

  // Approve: flips remaining proposed items to approved and enqueues one
  // draft_seed_document per approved item. Idempotent replay — items that
  // already carry a draftJobId are skipped, so re-approving after a mid-loop
  // failure completes the remainder.
  app.post("/:id/approve", requireScopes("manage:jobs"), async (c) => {
    const plan = await getSeedPlan(ctx, c.req.param("id"));
    if (!plan) {
      throw new HttpError(404, "plan_not_found");
    }
    assertCan(ctx, c, "manage", plan.flowId);
    const outcome = await approveSeedPlan(ctx, plan.id);
    if (!outcome.ok) {
      if (outcome.code === "plan_not_found") {
        throw new HttpError(404, outcome.code);
      }
      throw new HttpError(outcome.code === "coverage_required" ? 400 : 409, outcome.code);
    }
    return c.json({ plan: outcome.plan, jobIds: outcome.jobIds });
  });

  app.post("/:id/dismiss", requireScopes("manage:jobs"), async (c) => {
    const plan = await getSeedPlan(ctx, c.req.param("id"));
    if (!plan) {
      throw new HttpError(404, "plan_not_found");
    }
    assertCan(ctx, c, "manage", plan.flowId);
    const outcome = await dismissSeedPlan(ctx, plan.id);
    if (!outcome.ok) {
      throw new HttpError(outcome.code === "plan_not_found" ? 404 : 409, outcome.code);
    }
    return c.json({ plan: outcome.plan });
  });

  return app;
}
