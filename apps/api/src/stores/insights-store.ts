import type {
  FreshnessSummary,
  GapBacklogBucket,
  InsightsBucketUnit,
  JobErrorBreakdown,
  JobThroughputBucket,
  JourneySankey,
  LatencyBin,
  PatrolImpact,
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

// The result of a job-error-breakdown query (C6): failed pg-boss jobs over the
// window, split two ways — by error category and by job type. Both arrays are
// ordered most-frequent-first.
export interface JobErrorSplit {
  byCategory: JobErrorBreakdown[];
  byType: JobErrorBreakdown[];
}

export interface InsightsStore {
  gapBacklog(range: InsightsRange, flowId?: string): Promise<GapBacklogBucket[]>;
  jobThroughput(range: InsightsRange, queueNames?: string[]): Promise<JobThroughputBucket[]>;
  // Branching question-journey Sankey: nodes + positive-value links describing
  // the path questions take through gaps, clusters, proposals, and verification.
  // Source: `questions`, `question_gaps`, `gap_cluster_memberships`, `proposals`.
  journey(range: InsightsRange, flowId?: string): Promise<JourneySankey>;
  // Histogram of how long completed answers took (queued → completed), bucketed
  // into fixed latency ranges. Source: pg-boss answer_question job rows.
  answerLatency(range: InsightsRange): Promise<LatencyBin[]>;
  // Closed-vs-still-open split of gap-closure verification outcomes, overall and
  // per bucket. Source: the gap_closure_verification table.
  verificationSuccess(range: InsightsRange): Promise<VerificationSuccess>;
  // Failed-job counts over the window, grouped by error category and by job type.
  // Source: pg-boss `job` failed rows (error payload in `output`).
  jobErrors(range: InsightsRange): Promise<JobErrorSplit>;
  // Review-cycle compliance snapshot of the active KB. Source: `documents`
  // (`last_verified` + `review_cycle_days`) and `source_sync_state.last_checked_at`.
  freshness(): Promise<FreshnessSummary>;
  // Maintenance-patrol / gap→PR impact over the window, one row per task type.
  // Source: `maintenance_runs` (`task_type`, `details` JSONB).
  patrolImpact(range: InsightsRange): Promise<PatrolImpact[]>;
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
  async journey(): Promise<JourneySankey> {
    return { nodes: [], links: [] };
  }
  async answerLatency(): Promise<LatencyBin[]> {
    return [];
  }
  async verificationSuccess(): Promise<VerificationSuccess> {
    return { totals: { closed: 0, stillOpen: 0 }, series: [] };
  }
  async jobErrors(): Promise<JobErrorSplit> {
    return { byCategory: [], byType: [] };
  }
  async freshness(): Promise<FreshnessSummary> {
    return { documents: { fresh: 0, due: 0, overdue: 0 }, sources: { fresh: 0, stale: 0 } };
  }
  async patrolImpact(): Promise<PatrolImpact[]> {
    return [];
  }
}
