import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { HttpError } from "../../http/errors.js";
import * as insightsService from "./service.js";
import { insightsRangeQuerySchema, insightsWindowQuerySchema, jobThroughputQuerySchema } from "./schema.js";

// Read-only aggregation endpoints powering the web console's Insights page.
// Each returns a named-key envelope of already-bucketed, zero-filled series.
export function insightsRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/gaps/backlog", requireScopes("read:knowledge"), async (c) => {
    const parsed = insightsRangeQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400, "invalid_insights_query");
    return c.json({ series: await insightsService.gapBacklog(ctx, parsed.data) });
  });

  app.get("/funnel", requireScopes("read:knowledge"), async (c) => {
    const parsed = insightsRangeQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400, "invalid_insights_query");
    return c.json({ stages: await insightsService.funnel(ctx, parsed.data) });
  });

  app.get("/jobs/throughput", requireScopes("read:knowledge"), async (c) => {
    const parsed = jobThroughputQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400, "invalid_insights_query");
    return c.json({ series: await insightsService.jobThroughput(ctx, parsed.data) });
  });

  // C4 — answer-latency histogram. Binned by latency range, not time, so it takes
  // only the window bounds.
  app.get("/answers/latency", requireScopes("read:knowledge"), async (c) => {
    const parsed = insightsWindowQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400, "invalid_insights_query");
    return c.json({ bins: await insightsService.answerLatency(ctx, parsed.data) });
  });

  // C5 — verification success rate. Overall closed/still-open totals plus a
  // per-bucket trend.
  app.get("/verification/success", requireScopes("read:knowledge"), async (c) => {
    const parsed = insightsRangeQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400, "invalid_insights_query");
    const { totals, series } = await insightsService.verificationSuccess(ctx, parsed.data);
    return c.json({ totals, series });
  });

  return app;
}
