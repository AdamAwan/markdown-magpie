import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { parseLimit } from "../../platform/paths.js";
import * as gapsService from "./service.js";

export function gapRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/candidates", async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json({ gaps: await gapsService.listCandidates(ctx, limit) });
  });

  app.get("/clusters", async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json({ clusters: await gapsService.listClusters(ctx, limit) });
  });

  return app;
}
