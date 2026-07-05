import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as questionsService from "./service.js";
import { feedbackBodySchema } from "./schema.js";

export function questionRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json({ questions: await questionsService.listQuestions(ctx, limit) });
  });

  // Registered BEFORE "/:id" so "parked" is not captured as a question id.
  app.get("/parked", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json(await questionsService.listParked(ctx, limit));
  });

  app.get("/:id", requireScopes("read:knowledge"), async (c) => {
    const log = await questionsService.getQuestion(ctx, c.req.param("id"));
    if (!log) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question: log });
  });

  app.post(
    "/:id/feedback",
    requireScopes("feedback:questions"),
    zValidator("json", feedbackBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "valid_feedback_required" }, 400);
      }
    }),
    async (c) => {
      const { feedback } = c.req.valid("json");

      const question = await questionsService.recordFeedback(ctx, c.req.param("id"), feedback);
      if (!question) {
        throw new HttpError(404, "question_not_found");
      }
      return c.json({ question });
    }
  );

  app.post("/:id/gap", requireScopes("feedback:questions"), async (c) => {
    const payload = await readJsonBody<{ summary?: string }>(c);
    const summary = typeof payload.summary === "string" ? payload.summary : undefined;

    const question = await questionsService.recordManualGap(ctx, c.req.param("id"), summary);
    if (!question) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question });
  });

  app.delete("/:id/gap", requireScopes("feedback:questions"), async (c) => {
    const question = await questionsService.clearManualGap(ctx, c.req.param("id"));
    if (!question) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question });
  });

  // Human "retry" on a parked question — re-admit it to the pipeline. No-op (but
  // 200) if the question exists and is not parked; 404 only if there is no log.
  app.post("/:id/gap/retry", requireScopes("feedback:questions"), async (c) => {
    const question = await questionsService.retryParkedGap(ctx, c.req.param("id"));
    if (!question) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question });
  });

  // Human "dismiss" on a parked question — abandon the topic.
  app.post("/:id/gap/dismiss", requireScopes("feedback:questions"), async (c) => {
    const question = await questionsService.dismissParkedGap(ctx, c.req.param("id"));
    if (!question) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question });
  });

  return app;
}
