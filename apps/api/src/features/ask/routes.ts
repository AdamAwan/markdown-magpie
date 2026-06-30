import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { apiLink } from "../../platform/paths.js";
import * as askService from "./service.js";
import { askBodySchema } from "./schema.js";

export function askRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post(
    "/",
    requireScopes("ask:knowledge"),
    zValidator("json", askBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "question_required" }, 400);
      }
    }),
    async (c) => {
      const { question, flow } = c.req.valid("json");

      const outcome = await askService.ask(ctx, question, flow);
      return c.json(
        {
          questionId: outcome.questionId,
          job: outcome.job,
          links: {
            question: apiLink(`/questions/${outcome.questionId}`),
            job: apiLink(`/jobs/${outcome.job.id}`),
            wait: apiLink(`/jobs/${outcome.job.id}/wait`),
            cancel: apiLink(`/jobs/${outcome.job.id}/cancel`)
          }
        },
        202
      );
    }
  );

  return app;
}
