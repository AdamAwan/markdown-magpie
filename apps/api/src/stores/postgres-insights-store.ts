import pg from "pg";
import type {
  FreshnessSummary,
  FunnelStage,
  GapBacklogBucket,
  JobThroughputBucket,
  LatencyBin,
  PatrolImpact,
  VerificationBucket
} from "@magpie/core";
import { SCHEMA_IDENTIFIER } from "../jobs/pg-boss-broker.js";
import type { InsightsRange, InsightsStore, JobErrorSplit, VerificationSuccess } from "./insights-store.js";

// date_trunc units, whitelisted so the bucket unit is never interpolated from
// unvalidated input (the zod schema also constrains it to these three).
const UNIT: Record<InsightsRange["bucket"], "day" | "week" | "month"> = {
  day: "day",
  week: "week",
  month: "month"
};

// The queue-name prefix every answer_question queue shares. answer_question is a
// provider-routed job type, so it fans out to `answer_question__<provider>` work
// queues (and their `__dead_letter` siblings). Filtering completed rows by this
// prefix captures every provider; the state='completed' predicate excludes the
// dead-letter/failed rows so only genuinely answered questions are measured.
const ANSWER_QUEUE_PREFIX = "answer_question";

// Fixed latency ranges (seconds) for the answer-latency histogram. Ordered, with
// an open-ended final bucket (`to: null`). The SQL bins each completed answer by
// its (completed_on - created_on) duration into exactly one of these.
const LATENCY_BINS: ReadonlyArray<{ label: string; from: number; to: number | null }> = [
  { label: "0–5s", from: 0, to: 5 },
  { label: "5–15s", from: 5, to: 15 },
  { label: "15–30s", from: 15, to: 30 },
  { label: "30–60s", from: 30, to: 60 },
  { label: "1–2m", from: 60, to: 120 },
  { label: "2–5m", from: 120, to: 300 },
  { label: "5m+", from: 300, to: null }
];

// KB-freshness windows (C7). A document with a review cadence is "due" when its
// next review falls within FRESHNESS_SOON_DAYS of today (but is not yet past due);
// a source is "stale" when it has not been synced for FRESHNESS_STALE_DAYS.
const FRESHNESS_SOON_DAYS = 7;
const FRESHNESS_STALE_DAYS = 7;

export class PostgresInsightsStore implements InsightsStore {
  // `pgBossSchema` is the schema pg-boss stores its `job`/`archive` tables in. It
  // is interpolated into SQL (pg identifiers cannot be parameterised), so it is
  // re-validated against the same guard the broker uses before being trusted.
  constructor(
    private readonly pool: pg.Pool,
    private readonly pgBossSchema: string
  ) {
    if (!SCHEMA_IDENTIFIER.test(pgBossSchema)) {
      throw new Error(`Invalid pg-boss schema name: "${pgBossSchema}"`);
    }
  }

  // Open-gap backlog trend. Each bucket reports the lifecycle transitions that
  // happened within it (opened/resolved/dismissed/parked) and the running net
  // open total. v1 semantics: `openTotal` is the cumulative net (opened minus
  // closed) *within the requested window* — it does not carry a baseline of
  // gaps opened before `from`. For the default 30-day view that is the useful
  // "is the backlog growing or shrinking lately?" signal.
  async gapBacklog(range: InsightsRange, flowId?: string): Promise<GapBacklogBucket[]> {
    const unit = UNIT[range.bucket];
    const result = await this.pool.query<{
      bucket_start: Date;
      opened: string;
      resolved: string;
      dismissed: string;
      parked: string;
      open_total: string;
    }>(
      `
      WITH params AS (
        SELECT date_trunc($3, $1::timestamptz) AS from_b,
               date_trunc($3, $2::timestamptz) AS to_b
      ),
      buckets AS (
        SELECT generate_series(
          (SELECT from_b FROM params),
          (SELECT to_b FROM params),
          ('1 ' || $3)::interval
        ) AS b
      ),
      g AS (
        SELECT gg.created_at, gg.resolved_at, gg.dismissed_at, gg.parked_at
        FROM question_gaps gg
        LEFT JOIN questions q ON q.id = gg.question_id
        WHERE ($4::text IS NULL OR q.flow_id = $4)
      ),
      opened    AS (SELECT date_trunc($3, created_at)   AS b, count(*) AS n FROM g WHERE created_at   IS NOT NULL GROUP BY 1),
      resolved  AS (SELECT date_trunc($3, resolved_at)  AS b, count(*) AS n FROM g WHERE resolved_at  IS NOT NULL GROUP BY 1),
      dismissed AS (SELECT date_trunc($3, dismissed_at) AS b, count(*) AS n FROM g WHERE dismissed_at IS NOT NULL GROUP BY 1),
      parked    AS (SELECT date_trunc($3, parked_at)    AS b, count(*) AS n FROM g WHERE parked_at    IS NOT NULL GROUP BY 1),
      per_bucket AS (
        SELECT b.b AS bucket_start,
          coalesce(o.n, 0) AS opened,
          coalesce(r.n, 0) AS resolved,
          coalesce(d.n, 0) AS dismissed,
          coalesce(p.n, 0) AS parked
        FROM buckets b
        LEFT JOIN opened    o ON o.b = b.b
        LEFT JOIN resolved  r ON r.b = b.b
        LEFT JOIN dismissed d ON d.b = b.b
        LEFT JOIN parked    p ON p.b = b.b
      )
      SELECT bucket_start, opened, resolved, dismissed, parked,
        sum(opened - resolved - dismissed - parked) OVER (ORDER BY bucket_start) AS open_total
      FROM per_bucket
      ORDER BY bucket_start
      `,
      [range.from.toISOString(), range.to.toISOString(), unit, flowId ?? null]
    );

    return result.rows.map((row) => ({
      bucketStart: row.bucket_start.toISOString(),
      opened: Number(row.opened),
      resolved: Number(row.resolved),
      dismissed: Number(row.dismissed),
      parked: Number(row.parked),
      openTotal: Number(row.open_total)
    }));
  }

  // Job throughput & health (C2). Buckets pg-boss jobs by `created_on` and splits
  // them into completed / failed / active / retry counts per bucket.
  //
  // pg-boss keeps *live* rows in "<schema>".job and migrates completed/failed rows
  // to "<schema>".archive once they pass retention. Querying `job` alone would
  // therefore lose all finished history, so both tables are UNION ALL'd (a job is
  // in exactly one of them at a time, so there is no double counting). `type`, when
  // given, narrows to specific pg-boss queue names (resolved from a JobType by the
  // service layer); it is matched with `= ANY($4)` so it never touches SQL text.
  async jobThroughput(range: InsightsRange, queueNames?: string[]): Promise<JobThroughputBucket[]> {
    const unit = UNIT[range.bucket];
    // `undefined` means no type filter (match all queues); an explicit empty array
    // means "an unknown type was requested" and must match nothing, so it is passed
    // through as an empty `text[]` rather than collapsed to NULL.
    const names = queueNames ?? null;
    const result = await this.pool.query<{
      bucket_start: Date;
      completed: string;
      failed: string;
      active: string;
      retry: string;
    }>(
      `
      WITH params AS (
        SELECT date_trunc($3, $1::timestamptz) AS from_b,
               date_trunc($3, $2::timestamptz) AS to_b
      ),
      buckets AS (
        SELECT generate_series(
          (SELECT from_b FROM params),
          (SELECT to_b FROM params),
          ('1 ' || $3)::interval
        ) AS b
      ),
      jobs AS (
        SELECT name, state, created_on FROM "${this.pgBossSchema}".job
        UNION ALL
        SELECT name, state, created_on FROM "${this.pgBossSchema}".archive
      ),
      scoped AS (
        SELECT date_trunc($3, created_on) AS b, state::text AS state
        FROM jobs
        WHERE created_on >= (SELECT from_b FROM params)
          AND created_on <  (SELECT to_b FROM params) + ('1 ' || $3)::interval
          AND ($4::text[] IS NULL OR name = ANY($4))
      ),
      per_bucket AS (
        SELECT b,
          count(*) FILTER (WHERE state = 'completed')            AS completed,
          count(*) FILTER (WHERE state = 'failed')               AS failed,
          count(*) FILTER (WHERE state IN ('active', 'created')) AS active,
          count(*) FILTER (WHERE state = 'retry')                AS retry
        FROM scoped
        GROUP BY b
      )
      SELECT b.b AS bucket_start,
        coalesce(pb.completed, 0) AS completed,
        coalesce(pb.failed, 0)    AS failed,
        coalesce(pb.active, 0)    AS active,
        coalesce(pb.retry, 0)     AS retry
      FROM buckets b
      LEFT JOIN per_bucket pb ON pb.b = b.b
      ORDER BY b.b
      `,
      [range.from.toISOString(), range.to.toISOString(), unit, names]
    );

    return result.rows.map((row) => ({
      bucketStart: row.bucket_start.toISOString(),
      completed: Number(row.completed),
      failed: Number(row.failed),
      active: Number(row.active),
      retry: Number(row.retry)
    }));
  }

  // Gap-to-merge funnel: one count per pipeline stage over the window, in
  // pipeline order. Each stage counts the distinct entities that *entered* that
  // stage within [from, to], windowed on the timestamp that marks entry to the
  // stage. Stages narrow left-to-right so the drop-off between counts is the
  // conversion signal the chart visualises.
  //
  // Stage → table mapping (all real tables; no invented numbers):
  //   questions  → questions.asked_at                (a question was asked)
  //   gaps       → question_gaps.created_at           (a gap was raised)
  //   clustered  → question_gaps that have an active gap_cluster_memberships row
  //                (windowed on the gap's created_at — membership has no separate
  //                 lifecycle timestamp worth windowing on here)
  //   proposals  → proposals.created_at               (a proposal was drafted)
  //   prs        → proposals.created_at where status reached PR
  //                (status IN ('pr-opened','merged'); a merged proposal always
  //                 passed through pr-opened)
  //   merged     → proposals.merged_at                (the PR was merged)
  //   verified   → gap_closure_verification.created_at where verdict = 'closed'
  //
  // Flow filter: questions/gaps/clustered narrow via questions.flow_id;
  // proposals/prs/merged via proposals.flow_id; verified joins its proposal to
  // reach flow_id (gap_closure_verification has no flow_id column of its own).
  async funnel(range: InsightsRange, flowId?: string): Promise<FunnelStage[]> {
    const result = await this.pool.query<{
      questions: string;
      gaps: string;
      clustered: string;
      proposals: string;
      prs: string;
      merged: string;
      verified: string;
    }>(
      `
      WITH params AS (
        SELECT $1::timestamptz AS from_ts, $2::timestamptz AS to_ts, $3::text AS flow
      ),
      q AS (
        SELECT count(*) AS n
        FROM questions, params
        WHERE questions.asked_at >= params.from_ts AND questions.asked_at < params.to_ts
          AND (params.flow IS NULL OR questions.flow_id = params.flow)
      ),
      g AS (
        SELECT count(*) AS n
        FROM question_gaps gg
        JOIN questions qq ON qq.id = gg.question_id, params
        WHERE gg.created_at >= params.from_ts AND gg.created_at < params.to_ts
          AND (params.flow IS NULL OR qq.flow_id = params.flow)
      ),
      c AS (
        SELECT count(DISTINCT gg.id) AS n
        FROM question_gaps gg
        JOIN questions qq ON qq.id = gg.question_id
        JOIN gap_cluster_memberships m ON m.gap_id = gg.id AND m.active, params
        WHERE gg.created_at >= params.from_ts AND gg.created_at < params.to_ts
          AND (params.flow IS NULL OR qq.flow_id = params.flow)
      ),
      p AS (
        SELECT count(*) AS n
        FROM proposals pp, params
        WHERE pp.created_at >= params.from_ts AND pp.created_at < params.to_ts
          AND (params.flow IS NULL OR pp.flow_id = params.flow)
      ),
      pr AS (
        SELECT count(*) AS n
        FROM proposals pp, params
        WHERE pp.created_at >= params.from_ts AND pp.created_at < params.to_ts
          AND pp.status IN ('pr-opened', 'merged')
          AND (params.flow IS NULL OR pp.flow_id = params.flow)
      ),
      mg AS (
        SELECT count(*) AS n
        FROM proposals pp, params
        WHERE pp.merged_at IS NOT NULL
          AND pp.merged_at >= params.from_ts AND pp.merged_at < params.to_ts
          AND (params.flow IS NULL OR pp.flow_id = params.flow)
      ),
      v AS (
        SELECT count(*) AS n
        FROM gap_closure_verification gcv
        JOIN proposals pp ON pp.id = gcv.proposal_id, params
        WHERE gcv.verdict = 'closed'
          AND gcv.created_at >= params.from_ts AND gcv.created_at < params.to_ts
          AND (params.flow IS NULL OR pp.flow_id = params.flow)
      )
      SELECT q.n AS questions, g.n AS gaps, c.n AS clustered, p.n AS proposals,
             pr.n AS prs, mg.n AS merged, v.n AS verified
      FROM q, g, c, p, pr, mg, v
      `,
      [range.from.toISOString(), range.to.toISOString(), flowId ?? null]
    );

    const row = result.rows[0];
    return [
      { key: "questions", label: "Questions asked", count: Number(row.questions) },
      { key: "gaps", label: "Gaps raised", count: Number(row.gaps) },
      { key: "clustered", label: "Clustered", count: Number(row.clustered) },
      { key: "proposals", label: "Proposals drafted", count: Number(row.proposals) },
      { key: "prs", label: "PRs opened", count: Number(row.prs) },
      { key: "merged", label: "Merged", count: Number(row.merged) },
      { key: "verified", label: "Verified closed", count: Number(row.verified) }
    ];
  }

  // Answer-latency histogram (C4). Reads pg-boss's own job + archive tables (a
  // completed answer_question row migrates from `job` to `archive` after its
  // retention window, so both must be scanned or older answers vanish), measures
  // each completed answer's end-to-end duration (completed_on - created_on), and
  // bins it into the fixed LATENCY_BINS. `created_on` is used for the window filter
  // so a bar reflects answers *asked* in the last 30 days, matching the other
  // charts' "activity in the window" semantics. Empty bins are returned as zero so
  // the histogram always shows every range.
  async answerLatency(range: InsightsRange): Promise<LatencyBin[]> {
    // Bounds passed as parameters ($1/$2/$3); only the pg-boss schema is
    // interpolated, and it is regex-guarded in the constructor.
    const bounds = LATENCY_BINS.map((bin) => ({ from: bin.from, to: bin.to }));
    const result = await this.pool.query<{ idx: string; count: string }>(
      `
      WITH answers AS (
        SELECT created_on, completed_on
        FROM "${this.pgBossSchema}".job
        WHERE name LIKE $3 || '%' AND state = 'completed'
          AND completed_on IS NOT NULL
          AND created_on >= $1::timestamptz AND created_on <= $2::timestamptz
        UNION ALL
        SELECT created_on, completed_on
        FROM "${this.pgBossSchema}".archive
        WHERE name LIKE $3 || '%' AND state = 'completed'
          AND completed_on IS NOT NULL
          AND created_on >= $1::timestamptz AND created_on <= $2::timestamptz
      ),
      durations AS (
        SELECT extract(epoch FROM (completed_on - created_on)) AS seconds FROM answers
      ),
      bins AS (
        SELECT ordinality - 1 AS idx, (bound->>'from')::numeric AS lo,
               CASE WHEN bound->>'to' IS NULL THEN NULL ELSE (bound->>'to')::numeric END AS hi
        FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS t(bound, ordinality)
      )
      SELECT b.idx::int AS idx,
        count(d.seconds) FILTER (
          WHERE d.seconds >= b.lo AND (b.hi IS NULL OR d.seconds < b.hi)
        ) AS count
      FROM bins b
      LEFT JOIN durations d ON true
      GROUP BY b.idx
      ORDER BY b.idx
      `,
      [range.from.toISOString(), range.to.toISOString(), ANSWER_QUEUE_PREFIX, JSON.stringify(bounds)]
    );

    const counts = new Map(result.rows.map((row) => [Number(row.idx), Number(row.count)]));
    return LATENCY_BINS.map((bin, index) => ({
      label: bin.label,
      from: bin.from,
      to: bin.to,
      count: counts.get(index) ?? 0
    }));
  }

  // Verification success rate (C5). Splits gap_closure_verification rows by verdict
  // ('closed' = the merged doc now answers the re-asked question; 'still_open' =
  // it does not), reporting both the overall total across the window and the same
  // split per time bucket for the trend line. Buckets are zero-filled across the
  // range so the client renders a continuous series.
  async verificationSuccess(range: InsightsRange): Promise<VerificationSuccess> {
    const unit = UNIT[range.bucket];
    const result = await this.pool.query<{
      bucket_start: Date;
      closed: string;
      still_open: string;
    }>(
      `
      WITH params AS (
        SELECT date_trunc($3, $1::timestamptz) AS from_b,
               date_trunc($3, $2::timestamptz) AS to_b
      ),
      buckets AS (
        SELECT generate_series(
          (SELECT from_b FROM params),
          (SELECT to_b FROM params),
          ('1 ' || $3)::interval
        ) AS b
      ),
      v AS (
        SELECT date_trunc($3, created_at) AS b,
          count(*) FILTER (WHERE verdict = 'closed')      AS closed,
          count(*) FILTER (WHERE verdict = 'still_open')  AS still_open
        FROM gap_closure_verification
        WHERE created_at >= $1::timestamptz AND created_at <= $2::timestamptz
        GROUP BY 1
      )
      SELECT b.b AS bucket_start,
        coalesce(v.closed, 0)     AS closed,
        coalesce(v.still_open, 0) AS still_open
      FROM buckets b
      LEFT JOIN v ON v.b = b.b
      ORDER BY b.b
      `,
      [range.from.toISOString(), range.to.toISOString(), unit]
    );

    const series: VerificationBucket[] = result.rows.map((row) => ({
      bucketStart: row.bucket_start.toISOString(),
      closed: Number(row.closed),
      stillOpen: Number(row.still_open)
    }));
    const totals = series.reduce(
      (acc, bucket) => ({ closed: acc.closed + bucket.closed, stillOpen: acc.stillOpen + bucket.stillOpen }),
      { closed: 0, stillOpen: 0 }
    );
    return { totals, series };
  }

  // Job error breakdown (C6). Counts failed pg-boss jobs over the window, split by
  // error category and by job type in one round trip. pg-boss stores the JobError
  // payload in the job's `output` JSONB column when a job fails (see the broker's
  // `fail`), so `output->>'category'` is the error category. The queue `name` is
  // the job type plus an optional `__<capability>` fan-out suffix, so
  // `split_part(name, '__', 1)` recovers the base job type. Completed/failed rows
  // migrate from `job` to `archive` after retention, so both are UNION ALL'd (a job
  // is in exactly one at a time — no double counting). Ordered most-frequent-first.
  // The window filters on `created_on` (when the job was enqueued), not on failure
  // time, matching C2 `jobThroughput`'s creation-time axis; jobs fail shortly after
  // creation, so the two are effectively the same over a 30-day window.
  async jobErrors(range: InsightsRange): Promise<JobErrorSplit> {
    const result = await this.pool.query<{ dim: "category" | "type"; key: string; count: string }>(
      `
      WITH jobs AS (
        SELECT name, state, output, created_on FROM "${this.pgBossSchema}".job
        UNION ALL
        SELECT name, state, output, created_on FROM "${this.pgBossSchema}".archive
      ),
      failed AS (
        SELECT name, output
        FROM jobs
        WHERE state = 'failed'
          AND created_on >= $1::timestamptz AND created_on <= $2::timestamptz
      )
      SELECT 'category'::text AS dim, coalesce(output->>'category', 'unknown') AS key, count(*)::int AS count
      FROM failed GROUP BY 2
      UNION ALL
      SELECT 'type'::text AS dim, split_part(name, '__', 1) AS key, count(*)::int AS count
      FROM failed GROUP BY 2
      ORDER BY dim, count DESC, key
      `,
      [range.from.toISOString(), range.to.toISOString()]
    );

    const byCategory = result.rows
      .filter((row) => row.dim === "category")
      .map((row) => ({ key: row.key, count: Number(row.count) }));
    const byType = result.rows
      .filter((row) => row.dim === "type")
      .map((row) => ({ key: row.key, count: Number(row.count) }));
    return { byCategory, byType };
  }

  // Knowledge-base freshness (C7). A point-in-time snapshot, so it takes no window.
  //   documents: only active docs that carry a review cadence (review_cycle_days
  //     IS NOT NULL) are classified — a doc with no cadence is not subject to review
  //     and is excluded. next_review = last_verified + review_cycle_days; a doc that
  //     was never verified (last_verified IS NULL) counts as overdue.
  //       overdue → next_review < today (or never verified)
  //       due     → today <= next_review < today + FRESHNESS_SOON_DAYS
  //       fresh   → next_review >= today + FRESHNESS_SOON_DAYS
  //   sources: every source_sync_state row, split on last_checked_at.
  //       stale → last_checked_at < now() - FRESHNESS_STALE_DAYS
  //       fresh → otherwise
  async freshness(): Promise<FreshnessSummary> {
    const documents = await this.pool.query<{ fresh: string; due: string; overdue: string }>(
      `
      WITH classified AS (
        SELECT CASE
          WHEN last_verified IS NULL THEN 'overdue'
          WHEN (last_verified + (review_cycle_days || ' days')::interval)::date < current_date THEN 'overdue'
          WHEN (last_verified + (review_cycle_days || ' days')::interval)::date
               < current_date + ($1::int || ' days')::interval THEN 'due'
          ELSE 'fresh'
        END AS bucket
        FROM documents
        WHERE status = 'active' AND review_cycle_days IS NOT NULL
      )
      SELECT
        count(*) FILTER (WHERE bucket = 'fresh')   AS fresh,
        count(*) FILTER (WHERE bucket = 'due')     AS due,
        count(*) FILTER (WHERE bucket = 'overdue') AS overdue
      FROM classified
      `,
      [FRESHNESS_SOON_DAYS]
    );

    const sources = await this.pool.query<{ fresh: string; stale: string }>(
      `
      SELECT
        count(*) FILTER (WHERE last_checked_at >= now() - ($1::int || ' days')::interval) AS fresh,
        count(*) FILTER (WHERE last_checked_at <  now() - ($1::int || ' days')::interval) AS stale
      FROM source_sync_state
      `,
      [FRESHNESS_STALE_DAYS]
    );

    const doc = documents.rows[0];
    const src = sources.rows[0];
    return {
      documents: { fresh: Number(doc.fresh), due: Number(doc.due), overdue: Number(doc.overdue) },
      sources: { fresh: Number(src.fresh), stale: Number(src.stale) }
    };
  }

  // Maintenance patrol impact (C8). One row per maintenance_runs.task_type over the
  // window, windowed on started_at. Each task type records a different payload in
  // `details`, so each metric reads the key its runs actually write and stays zero
  // elsewhere: patrol runs store a `details.findings` JSONB array (verify-lens
  // findings), the gap→PR reconciler stores a numeric `details.proposalsDrafted`.
  async patrolImpact(range: InsightsRange): Promise<PatrolImpact[]> {
    const result = await this.pool.query<{
      task_type: string;
      runs: string;
      findings: string;
      proposals: string;
    }>(
      `
      SELECT task_type,
        count(*) AS runs,
        coalesce(sum(
          CASE WHEN jsonb_typeof(details->'findings') = 'array'
            THEN jsonb_array_length(details->'findings') ELSE 0 END
        ), 0) AS findings,
        coalesce(sum(
          CASE WHEN jsonb_typeof(details->'proposalsDrafted') = 'number'
            THEN (details->>'proposalsDrafted')::int ELSE 0 END
        ), 0) AS proposals
      FROM maintenance_runs
      WHERE started_at >= $1::timestamptz AND started_at <= $2::timestamptz
      GROUP BY task_type
      ORDER BY task_type
      `,
      [range.from.toISOString(), range.to.toISOString()]
    );

    return result.rows.map((row) => ({
      taskType: row.task_type,
      runs: Number(row.runs),
      findings: Number(row.findings),
      proposals: Number(row.proposals)
    }));
  }
}
