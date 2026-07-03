import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan } from "../../auth/capabilities.js";
import { HttpError } from "../../http/errors.js";
import { seedFlow } from "../proposals/service.js";
import { seedBodySchema } from "./schema.js";

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

  return app;
}
