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
      const { question } = c.req.valid("json");

      const outcome = await askService.ask(ctx, question);
      if (outcome.kind === "queue") {
        return c.json(
          {
            mode: "queue",
            questionId: outcome.questionId,
            job: outcome.job,
            links: {
              question: apiLink(`/questions/${outcome.questionId}`),
              status: apiLink(`/ai-jobs/${outcome.job.id}`)
            }
          },
          202
        );
      }

      return c.json({ mode: outcome.mode, questionId: outcome.questionId, result: outcome.result });
    }
  );

  return app;
}
