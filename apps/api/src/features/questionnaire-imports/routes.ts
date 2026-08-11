import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan } from "../../auth/capabilities.js";
import { HttpError } from "../../http/errors.js";
import { rateLimit } from "../../http/rate-limit.js";
import { confirmImportSchema } from "./schema.js";
import {
  confirmQuestionnaireImport,
  discardQuestionnaireImport,
  getQuestionnaireImport,
  uploadQuestionnaireImport
} from "./service.js";

// Uploading a questionnaire file, mounted at /api/questionnaire-imports
// (docs/questionnaires.md Q29+). Upload sits under the `trigger` tier for the
// same reason creation does — it fans out AI work — and every read is
// flow-scoped through the import's own flow, cross-flow reading as 404.

export function questionnaireImportRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post("/", requireScopes("ask:knowledge"), rateLimit(ctx, "trigger"), async (c) => {
    const body = await c.req.parseBody().catch(() => undefined);
    const file = body?.["file"];
    const flowId = body?.["flowId"];
    const name = body?.["name"];
    if (!(file instanceof File) || typeof flowId !== "string" || typeof name !== "string" || name.trim().length === 0) {
      throw new HttpError(400, "invalid_upload");
    }
    if (!ctx.knowledgeConfig.flows.some((flow) => flow.id === flowId)) {
      throw new HttpError(404, "flow_not_found");
    }
    assertCan(ctx, c, "ask", flowId);
    const outcome = await uploadQuestionnaireImport(ctx, {
      flowId,
      name: name.trim(),
      filename: file.name,
      // The only place the uploaded bytes exist. They are parsed inside the
      // service and never persisted.
      bytes: new Uint8Array(await file.arrayBuffer())
    });
    if (!outcome.ok) {
      throw new HttpError(outcome.code === "flow_not_found" ? 404 : 400, outcome.code);
    }
    return c.json({ import: outcome.import }, 202);
  });

  app.get("/:id", requireScopes("read:knowledge"), async (c) => {
    const view = await getQuestionnaireImport(ctx, c.req.param("id"));
    if (!view) {
      throw new HttpError(404, "import_not_found");
    }
    assertCan(ctx, c, "read", view.import.flowId);
    return c.json(view);
  });

  app.post(
    "/:id/confirm",
    requireScopes("manage:knowledge"),
    zValidator("json", confirmImportSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid_import_confirmation" }, 400);
      }
      return undefined;
    }),
    async (c) => {
      const found = await ctx.stores.questionnaireImports.get(c.req.param("id"));
      if (!found) {
        throw new HttpError(404, "import_not_found");
      }
      assertCan(ctx, c, "manage", found.flowId);
      const body = c.req.valid("json");
      const outcome = await confirmQuestionnaireImport(ctx, found.id, {
        sheets: body.sheets,
        ...(body.promoted ? { promoted: body.promoted } : {})
      });
      if (!outcome.ok) {
        throw new HttpError(outcome.code === "not_found" ? 404 : 409, outcome.code);
      }
      return c.json({ questionnaire: outcome.questionnaire }, 201);
    }
  );

  app.delete("/:id", requireScopes("manage:knowledge"), async (c) => {
    const found = await ctx.stores.questionnaireImports.get(c.req.param("id"));
    if (!found) {
      throw new HttpError(404, "import_not_found");
    }
    assertCan(ctx, c, "manage", found.flowId);
    await discardQuestionnaireImport(ctx, found.id);
    return c.json({ ok: true });
  });

  return app;
}
