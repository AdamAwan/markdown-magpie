import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { normalizeAiExecutionMode, normalizeAiProvider } from "../../config-holder.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as configService from "./service.js";

export function configRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/config", (c) => c.json(configService.getRuntimeConfig(ctx)));

  app.post("/config", async (c) => {
    const payload = await readJsonBody<{
      aiExecutionMode?: string;
      aiProvider?: string;
      ai?: { executionMode?: string; provider?: string };
    }>(c);
    const nextExecutionMode = normalizeAiExecutionMode(payload.ai?.executionMode ?? payload.aiExecutionMode);
    const nextProvider = normalizeAiProvider(payload.ai?.provider ?? payload.aiProvider);

    if (!nextExecutionMode || !nextProvider) {
      throw new HttpError(400, "valid_ai_runtime_config_required");
    }

    const error = ctx.config.update({ aiExecutionMode: nextExecutionMode, aiProvider: nextProvider });
    if (error) {
      throw new HttpError(400, "unsupported_ai_runtime_config", error);
    }

    return c.json(configService.getRuntimeConfig(ctx));
  });

  app.post("/admin/reset", async (c) => {
    const { reindexed, failures, stats } = await configService.resetData(ctx);
    return c.json({ ok: true, reindexed, failures, stats });
  });

  return app;
}
