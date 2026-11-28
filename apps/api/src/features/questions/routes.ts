import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { can, canAny, readableFlowIds, requirePrivilege } from "../../auth/capabilities.js";
import { parseLimit, parseOffset } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as questionsService from "./service.js";
import { feedbackBodySchema } from "./schema.js";

export function questionRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  // Feedback, manual gap flags and parked-gap decisions act on (and return) one
  // question, so the caller must be able to see that question's flow: `read`
  // (a curator) or `ask` (the asker giving feedback on an answer, e.g. MCP
  // kb_feedback). A question in any other flow — or none, without a "*" grant —
  // is a 404, never a 403 (docs/authorization.md AZ33).
  const assertQuestionActionable = async (c: Context, id: string): Promise<void> => {
    const question = await questionsService.getQuestion(ctx, id);
    if (!question || !canAny(ctx, c, ["read", "ask"], question.flowId)) {
      throw new HttpError(404, "question_not_found");
    }
  };

  // The question log, filtered to the flows the caller may read; the totals
  // count the same visible set so the pager stays honest.
  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    const offset = parseOffset(c.req.query("offset") ?? null);
    const search = c.req.query("q");
    const flowIds = readableFlowIds(ctx, c, ["read"]);
    return c.json(
      await questionsService.listQuestions(ctx, { limit, offset, search, ...(flowIds ? { flowIds } : {}) })
    );
  });

  // Registered BEFORE "/:id" so "parked" is not captured as a question id.
  app.get("/parked", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json(await questionsService.listParked(ctx, limit, (flowId) => can(ctx, c, "read", flowId)));
  });

  app.get("/:id", requireScopes("read:knowledge"), async (c) => {
    const log = await questionsService.getQuestion(ctx, c.req.param("id"));
    if (!log || !can(ctx, c, "read", log.flowId)) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question: log });
  });

  // Purge a question that contained sensitive information. `?scrub=true` also
  // cleans the downstream clusters and unpublished proposals it seeded (published
  // proposals come back as warnings). Destructive and irreversible, so gated by
  // manage:admin like the other data-wiping endpoints.
  app.delete("/:id", requireScopes("manage:admin"), requirePrivilege(ctx, "admin"), async (c) => {
    const scrub = c.req.query("scrub") === "true";
    const report = await questionsService.deleteQuestion(ctx, c.req.param("id"), { scrub });
    if (!report) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json(report);
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
      await assertQuestionActionable(c, c.req.param("id"));

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
    await assertQuestionActionable(c, c.req.param("id"));

    const question = await questionsService.recordManualGap(ctx, c.req.param("id"), summary);
    if (!question) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question });
  });

  app.delete("/:id/gap", requireScopes("feedback:questions"), async (c) => {
    await assertQuestionActionable(c, c.req.param("id"));
    const question = await questionsService.clearManualGap(ctx, c.req.param("id"));
    if (!question) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question });
  });

  // Human "retry" on a parked question — re-admit it to the pipeline. No-op (but
  // 200) if the question exists and is not parked; 404 only if there is no log.
  app.post("/:id/gap/retry", requireScopes("feedback:questions"), async (c) => {
    await assertQuestionActionable(c, c.req.param("id"));
    const question = await questionsService.retryParkedGap(ctx, c.req.param("id"));
    if (!question) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question });
  });

  // Human "dismiss" on a parked question — abandon the topic.
  app.post("/:id/gap/dismiss", requireScopes("feedback:questions"), async (c) => {
    await assertQuestionActionable(c, c.req.param("id"));
    const question = await questionsService.dismissParkedGap(ctx, c.req.param("id"));
    if (!question) {
      throw new HttpError(404, "question_not_found");
    }
    return c.json({ question });
  });

  return app;
}
