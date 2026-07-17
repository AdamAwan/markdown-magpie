import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan } from "../../auth/capabilities.js";
import { rateLimit } from "../../http/rate-limit.js";
import * as routeService from "./service.js";

const routeBodySchema = z.object({
  question: z.string().trim().min(1),
  flows: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        persona: z.string().optional()
      })
    )
    .default([])
});

// Cheap embedding-similarity flow routing the watcher calls before answering, so a
// confident route never bills a chat completion. Same scope + rate tier as
// /api/retrieve (both are watcher callbacks on the answering path).
export function routeRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post(
    "/",
    requireScopes("ask:knowledge"),
    rateLimit(ctx, "ask"),
    zValidator("json", routeBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "question_required" }, 400);
      }
    }),
    async (c) => {
      const { question, flows } = c.req.valid("json");

      // Free flow routing across the caller-supplied candidates is exactly the
      // flow-less case of /api/ask ("auto"/absent): only a wildcard `ask` asker may
      // let the router pick a flow for them. A single-flow asker must name their flow
      // (via /api/ask or /api/retrieve). Genuine service principals (the watcher) keep
      // routing via the existing client-credentials carve-out.
      assertCan(ctx, c, "ask", undefined);

      const result = await routeService.route(ctx, { question, flows });
      return c.json(result);
    }
  );

  return app;
}
