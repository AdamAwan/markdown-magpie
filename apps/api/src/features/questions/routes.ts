import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as questionsService from "./service.js";

export function questionRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json({ questions: await questionsService.listQuestions(ctx, limit) });
  });

  app.get("/:id", async (c) => {
    const log = await questionsService.getQuestion(ctx, c.req.param("id"));
    if (!log) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question: log });
  });

  app.post("/:id/feedback", async (c) => {
    const payload = await readJsonBody<{ feedback?: unknown }>(c);

    if (!questionsService.isQuestionFeedback(payload.feedback)) {
      throw new HttpError(400, "valid_feedback_required");
    }

    const question = await questionsService.recordFeedback(ctx, c.req.param("id"), payload.feedback);
    if (!question) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question });
  });

  app.post("/:id/gap", async (c) => {
    const payload = await readJsonBody<{ summary?: string }>(c);
    const summary = typeof payload.summary === "string" ? payload.summary : undefined;

    const question = await questionsService.recordManualGap(ctx, c.req.param("id"), summary);
    if (!question) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question });
  });

  app.delete("/:id/gap", async (c) => {
    const question = await questionsService.clearManualGap(ctx, c.req.param("id"));
    if (!question) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question });
  });

  return app;
}
