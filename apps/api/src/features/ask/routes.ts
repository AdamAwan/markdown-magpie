import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { apiLink } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as askService from "./service.js";

export function askRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post("/ask", async (c) => {
    const payload = await readJsonBody<{ question?: string }>(c);
    const question = payload.question?.trim();

    if (!question) {
      throw new HttpError(400, "question_required");
    }

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
  });

  return app;
}
