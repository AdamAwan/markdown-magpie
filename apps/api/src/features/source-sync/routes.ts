import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { readJsonBody } from "../../http/body.js";
import * as sourceSyncService from "./service.js";

export function sourceSyncRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  // Thin orchestration endpoint the maintenance watcher's source_change_sync
  // runner POSTs. The heavy gather (checkout/diff/candidate retrieval) and the
  // generative step (an enqueued AI job) stay here. The
  // body is optional; an absent flowId watches every configured git source.
  app.post("/run", requireScopes("manage:jobs"), async (c) => {
    const payload = await readJsonBody<{ flowId?: string }>(c);
    return c.json(await sourceSyncService.triggerSourceSyncRun(ctx, {
      flowId: payload.flowId?.trim() || undefined,
      trigger: "scheduled"
    }));
  });

  return app;
}
