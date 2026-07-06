import type {
  FunnelStage,
  GapBacklogBucket,
  InsightsBucketUnit,
  JobThroughputBucket,
  LatencyBin,
  VerificationBucket,
  VerificationSummary
} from "@magpie/core";

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
// The result of a verification-success query: the overall closed/still-open split
// across the window plus the same split per time bucket for the trend line.
export interface VerificationSuccess {
  totals: VerificationSummary;
  series: VerificationBucket[];
}

export interface InsightsStore {
  gapBacklog(range: InsightsRange, flowId?: string): Promise<GapBacklogBucket[]>;
  jobThroughput(range: InsightsRange, queueNames?: string[]): Promise<JobThroughputBucket[]>;
  funnel(range: InsightsRange, flowId?: string): Promise<FunnelStage[]>;
  // Histogram of how long completed answers took (queued → completed), bucketed
  // into fixed latency ranges. Source: pg-boss answer_question job rows.
  answerLatency(range: InsightsRange): Promise<LatencyBin[]>;
  // Closed-vs-still-open split of gap-closure verification outcomes, overall and
  // per bucket. Source: the gap_closure_verification table.
  verificationSuccess(range: InsightsRange): Promise<VerificationSuccess>;
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
  async answerLatency(): Promise<LatencyBin[]> {
    return [];
  }
  async verificationSuccess(): Promise<VerificationSuccess> {
    return { totals: { closed: 0, stillOpen: 0 }, series: [] };
  }
}
