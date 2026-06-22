import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as sourceSyncService from "./service.js";

export function sourceSyncRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/runs", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 20);
    return c.json({ runs: await sourceSyncService.listRuns(ctx, limit) });
  });

  // Thin orchestration endpoint the maintenance watcher's source_change_sync
  // runner POSTs. The heavy gather (checkout/diff/candidate retrieval) and the
  // generative step (an enqueued AI job the API bounded-waits on) stay here. The
  // body is optional; an absent flowId watches every configured git source.
  // Same admin scope as /api/gaps/reconcile.
  app.post("/run", requireScopes("manage:jobs"), async (c) => {
    const payload = await readJsonBody<{ flowId?: string }>(c);
    const runs = await sourceSyncService.triggerSourceSyncRun(ctx, {
      flowId: payload.flowId?.trim() || undefined,
      trigger: "scheduled"
    });
    return c.json({ runIds: runs.map((run) => run.id) });
  });

  // The non-generative execution context the watcher's publish_source_sync runner
  // fetches before executing git: the run (with its persisted changeset), the
  // source name for the commit title, and the credential-free repository config.
  app.get("/runs/:id/execution-context", requireScopes("manage:knowledge"), async (c) => {
    const outcome = await sourceSyncService.getRunExecutionContext(ctx, c.req.param("id"));
    if (!outcome.ok) {
      throw new HttpError(outcome.status, outcome.code, outcome.message);
    }
    return c.json({ run: outcome.run, sourceName: outcome.sourceName, repository: outcome.repository });
  });

  app.get("/runs/:id", requireScopes("read:knowledge"), async (c) => {
    const run = await sourceSyncService.getRun(ctx, c.req.param("id"));
    if (!run) {
      throw new HttpError(404, "source_sync_run_not_found");
    }
    return c.json({ run });
  });

  return app;
}
