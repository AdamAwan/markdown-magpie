import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan } from "../../auth/capabilities.js";
import { normalizeAiProvider } from "../../config-holder.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import { reconcileSchedules } from "../../jobs/schedule-reconciler.js";
import * as configService from "./service.js";

export function configRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("manage:admin"), (c) => c.json(configService.getRuntimeConfig(ctx)));

  app.post("/", requireScopes("manage:admin"), async (c) => {
    const payload = await readJsonBody<{
      aiProvider?: string;
      ai?: { provider?: string };
    }>(c);
    const nextProvider = normalizeAiProvider(payload.ai?.provider ?? payload.aiProvider);

    if (!nextProvider) {
      throw new HttpError(400, "valid_ai_provider_required");
    }

    const error = ctx.config.update({ aiProvider: nextProvider });
    if (error) {
      throw new HttpError(400, "unsupported_ai_provider", error);
    }

    // Re-derive schedules from current settings. Harmless and idempotent here; it
    // keeps the queue in sync if a config change ever influences scheduling.
    await reconcileSchedules(ctx);
    return c.json(configService.getRuntimeConfig(ctx));
  });

  return app;
}

export function adminRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post("/reset", requireScopes("manage:admin"), async (c) => {
    // Reset is the single destructive, deployment-wide action (it wipes all data).
    // Beyond the manage:admin scope it also requires the `admin` capability, so a
    // routine admin can't be handed the power to erase everyone's knowledge base by
    // scope alone. `admin` is only ever granted on the "*" flow (a super-admin
    // role). Inactive — and thus scope-only, as before — until grants are configured.
    assertCan(ctx, c, "admin", undefined);
    const { reindexed, failures, stats } = await configService.resetData(ctx);
    return c.json({ ok: true, reindexed, failures, stats });
  });

  return app;
}
