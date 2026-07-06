import type { FunnelStage, GapBacklogBucket, InsightsBucketUnit, JobThroughputBucket } from "@magpie/core";

// A resolved time range for an insight query: an explicit window plus the
// bucket granularity. The routes layer applies defaults (last 30 days, daily)
// before constructing this.
export interface InsightsRange {
  from: Date;
  to: Date;
  bucket: InsightsBucketUnit;
}

// Read-only aggregation over the domain tables for the Insights page. All
// results are zero-filled across the requested range so the client renders a
// continuous series without gap-filling itself.
export interface InsightsStore {
  gapBacklog(range: InsightsRange, flowId?: string): Promise<GapBacklogBucket[]>;
  jobThroughput(range: InsightsRange, queueNames?: string[]): Promise<JobThroughputBucket[]>;
  funnel(range: InsightsRange, flowId?: string): Promise<FunnelStage[]>;
}

// Used when the process runs without a Postgres pool (in-memory unit tests):
// there is no data to aggregate, so every query returns an empty series. The
// routes still respond 200 with an empty envelope, which is what the Hono unit
// tests assert.
export class NullInsightsStore implements InsightsStore {
  async gapBacklog(): Promise<GapBacklogBucket[]> {
    return [];
  }
  async jobThroughput(): Promise<JobThroughputBucket[]> {
    return [];
  }
  async funnel(): Promise<FunnelStage[]> {
    return [];
  }
}
