import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import * as workersService from "./service.js";

// The connected-watcher view behind the Jobs screen's Workers panel. Read-only:
// the registry is populated as a side effect of the watcher's own claim/heartbeat
// calls (see features/jobs/service.ts), so there is nothing to mutate here.
export function workerRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("read:knowledge"), async (c) =>
    c.json({ workers: await workersService.listWatchers(ctx) }));

  return app;
}
