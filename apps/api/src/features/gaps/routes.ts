import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { parseLimit } from "../../platform/paths.js";
import * as gapsService from "./service.js";

export function gapRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/candidates", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json({ gaps: await gapsService.listCandidates(ctx, limit) });
  });

  app.get("/clusters", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json({ clusters: await gapsService.listClusters(ctx, limit) });
  });

  return app;
}
