import type { FunnelStage, GapBacklogBucket, JobThroughputBucket } from "@magpie/core";
import { isJobType } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { queueDefinitionsForType } from "../../jobs/pg-boss-broker.js";
import type { InsightsRange } from "../../stores/insights-store.js";
import type { InsightsRangeQuery, JobThroughputQuery } from "./schema.js";

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

export async function funnel(ctx: AppContext, query: InsightsRangeQuery): Promise<FunnelStage[]> {
  return ctx.stores.insights.funnel(resolveRange(query), query.flow);
}

// Resolve an optional job-type filter to the pg-boss queue names that type's work
// lands in (its work queue(s) plus dead-letter queues). An unknown type yields an
// empty list, which the store treats as "match nothing" — a safe, explicit empty
// series rather than silently ignoring the filter.
export async function jobThroughput(ctx: AppContext, query: JobThroughputQuery): Promise<JobThroughputBucket[]> {
  const queueNames = query.type
    ? isJobType(query.type)
      ? queueDefinitionsForType(query.type).map((queue) => queue.name)
      : []
    : undefined;
  return ctx.stores.insights.jobThroughput(resolveRange(query), queueNames);
}
