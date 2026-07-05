import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { HttpError } from "../../http/errors.js";
import * as insightsService from "./service.js";
import { insightsRangeQuerySchema } from "./schema.js";

// Read-only aggregation endpoints powering the web console's Insights page.
// Each returns a named-key envelope of already-bucketed, zero-filled series.
export function insightsRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/gaps/backlog", requireScopes("read:knowledge"), async (c) => {
    const parsed = insightsRangeQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400, "invalid_insights_query");
    return c.json({ series: await insightsService.gapBacklog(ctx, parsed.data) });
  });

  return app;
}
