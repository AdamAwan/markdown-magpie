import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
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
    zValidator("json", retrieveBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "question_required" }, 400);
      }
    }),
    async (c) => {
      const { question, flowId, limit } = c.req.valid("json");
      const result = await retrieveService.retrieve(ctx, {
        question,
        ...(flowId ? { flowId } : {}),
        ...(limit ? { limit } : {})
      });
      return c.json(result);
    }
  );

  return app;
}
