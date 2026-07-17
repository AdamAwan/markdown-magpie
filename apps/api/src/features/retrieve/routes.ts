import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan } from "../../auth/capabilities.js";
import { rateLimit } from "../../http/rate-limit.js";
import * as retrieveService from "./service.js";

const retrieveBodySchema = z.object({
  question: z.string().trim().min(1),
  flowId: z.string().optional(),
  limit: z.number().int().positive().max(50).optional()
});

export function retrieveRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post(
    "/",
    requireScopes("ask:knowledge"),
    rateLimit(ctx, "ask"),
    zValidator("json", retrieveBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "question_required" }, 400);
      }
    }),
    async (c) => {
      const { question, flowId, limit } = c.req.valid("json");

      // Flow-scoped retrieval: mirror /api/ask so a role-aware user can only pull
      // section content for a flow they hold `ask` on. An absent flowId is the
      // unscoped (all-flows) search, treated as the flow-less/wildcard case — only a
      // `*` asker (or a genuine service principal, e.g. the watcher) may run it.
      assertCan(ctx, c, "ask", flowId);

      const result = await retrieveService.retrieve(ctx, {
        question,
        ...(flowId ? { flowId } : {}),
        ...(limit ? { limit } : {})
      });
      if (!result.ok) {
        return c.json({ error: result.code }, 422);
      }
      return c.json({ sections: result.sections });
    }
  );

  return app;
}
