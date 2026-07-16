import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan } from "../../auth/capabilities.js";
import { HttpError } from "../../http/errors.js";
import { rateLimit } from "../../http/rate-limit.js";
import { exportQuestionnaire } from "./export.js";
import { approveItem, approveReused, createQuestionnaire, getQuestionnaire, listQuestionnaires } from "./service.js";
import { createQuestionnaireSchema, exportQuerySchema } from "./schema.js";

// Questionnaire routes, mounted at /api/questionnaires (docs/questionnaires.md).
// Creation sits under the `trigger` rate tier (it fans out AI work — the drip
// governs actual queue pressure); reads follow the cross-flow-reads-as-404
// convention via assertCan on the questionnaire's flow.
export function questionnaireRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post(
    "/",
    requireScopes("ask:knowledge"),
    rateLimit(ctx, "trigger"),
    zValidator("json", createQuestionnaireSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid_questionnaire_body" }, 400);
      }
    }),
    async (c) => {
      const body = c.req.valid("json");
      if (!ctx.knowledgeConfig.flows.some((flow) => flow.id === body.flowId)) {
        throw new HttpError(404, "flow_not_found");
      }
      assertCan(ctx, c, "ask", body.flowId);
      const outcome = await createQuestionnaire(ctx, body);
      if (!outcome.ok) {
        throw new HttpError(outcome.code === "flow_not_found" ? 404 : 400, outcome.code);
      }
      return c.json({ questionnaire: outcome.questionnaire }, 201);
    }
  );

  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const summaries = await listQuestionnaires(ctx);
    return c.json({ questionnaires: summaries });
  });

  app.get("/:id", requireScopes("read:knowledge"), async (c) => {
    const questionnaire = await getQuestionnaire(ctx, c.req.param("id"));
    if (!questionnaire) {
      throw new HttpError(404, "questionnaire_not_found");
    }
    assertCan(ctx, c, "read", questionnaire.flowId);
    return c.json({ questionnaire });
  });

  app.get("/:id/export", requireScopes("read:knowledge"), async (c) => {
    const questionnaire = await getQuestionnaire(ctx, c.req.param("id"));
    if (!questionnaire) {
      throw new HttpError(404, "questionnaire_not_found");
    }
    assertCan(ctx, c, "read", questionnaire.flowId);
    const query = exportQuerySchema.safeParse({ format: c.req.query("format") ?? undefined });
    if (!query.success) {
      throw new HttpError(400, "invalid_export_format");
    }
    const format = query.data.format;
    const body = exportQuestionnaire(questionnaire, format);
    c.header("content-type", format === "md" ? "text/markdown; charset=utf-8" : "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${questionnaire.id}.${format}"`);
    return c.body(body);
  });

  app.post("/:id/items/:itemId/approve", requireScopes("manage:knowledge"), async (c) => {
    const questionnaire = await ctx.stores.questionnaires.get(c.req.param("id"));
    if (!questionnaire) {
      throw new HttpError(404, "questionnaire_not_found");
    }
    assertCan(ctx, c, "manage", questionnaire.flowId);
    const outcome = await approveItem(ctx, questionnaire.id, c.req.param("itemId"));
    if (!outcome.ok) {
      throw new HttpError(outcome.code === "not_found" ? 404 : 409, outcome.code);
    }
    return c.json({ ok: true });
  });

  app.post("/:id/approve-reused", requireScopes("manage:knowledge"), async (c) => {
    const questionnaire = await ctx.stores.questionnaires.get(c.req.param("id"));
    if (!questionnaire) {
      throw new HttpError(404, "questionnaire_not_found");
    }
    assertCan(ctx, c, "manage", questionnaire.flowId);
    const outcome = await approveReused(ctx, questionnaire.id);
    return c.json(outcome);
  });

  return app;
}
