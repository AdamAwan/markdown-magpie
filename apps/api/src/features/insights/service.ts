import type { GapBacklogBucket } from "@magpie/core";
import type { AppContext } from "../../context.js";
import type { InsightsRange } from "../../stores/insights-store.js";
import type { InsightsRangeQuery } from "./schema.js";

const DEFAULT_WINDOW_DAYS = 30;

// Resolve the optional from/to query params into a concrete range, defaulting to
// the last 30 days (the v1 fixed window). `to` defaults to now; `from` defaults
// to 30 days before `to`.
export function resolveRange(query: InsightsRangeQuery): InsightsRange {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 3600 * 1000);
  return { from, to, bucket: query.bucket };
}

export async function gapBacklog(ctx: AppContext, query: InsightsRangeQuery): Promise<GapBacklogBucket[]> {
  return ctx.stores.insights.gapBacklog(resolveRange(query), query.flow);
}
