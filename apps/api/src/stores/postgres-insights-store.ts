import pg from "pg";
import type {
  AiUsageBreakdown,
  FeedbackBucket,
  FreshnessSummary,
  GapBacklogBucket,
  JobThroughputBucket,
  JourneyLink,
  JourneyNode,
  JourneySankey,
  LatencyBin,
  PatrolImpact,
  VerificationBucket
} from "@magpie/core";
import { allQueueDefinitions, isAiProviderName } from "@magpie/jobs";
import { SCHEMA_IDENTIFIER } from "../jobs/pg-boss-broker.js";
import { estimateTokenCost, type AiPricingEntry } from "../platform/ai-pricing.js";
import type {
  AnswerFeedback,
  InsightsRange,
  InsightsStore,
  JobErrorSplit,
  VerificationSuccess
} from "./insights-store.js";

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

// Every node the journey Sankey can contain, in draw order (left-to-right). The
// assembler emits only the nodes referenced by a positive-value link, so empty
// segments drop out cleanly.
const JOURNEY_NODES: ReadonlyArray<JourneyNode> = [
  { key: "questions", label: "Questions asked", segment: "answer" },
  { key: "conf_high", label: "High confidence", segment: "answer" },
  { key: "conf_medium", label: "Medium confidence", segment: "answer" },
  { key: "conf_low", label: "Low confidence", segment: "answer" },
  { key: "conf_unknown", label: "Unknown confidence", segment: "answer" },
  { key: "no_gap", label: "Answered, no gap", segment: "answer" },
  { key: "gaps", label: "Gaps raised", segment: "gap" },
  { key: "gap_dismissed", label: "Dismissed", segment: "gap" },
  { key: "gap_parked", label: "Parked", segment: "gap" },
  { key: "gap_open", label: "Open (in flight)", segment: "gap" },
  { key: "clustered", label: "Clustered", segment: "gap" },
  { key: "proposals", label: "Proposals drafted", segment: "proposal" },
  { key: "prop_inprogress", label: "In progress", segment: "proposal" },
  { key: "prop_rejected", label: "Rejected", segment: "proposal" },
  { key: "prop_superseded", label: "Superseded", segment: "proposal" },
  { key: "merged", label: "Merged", segment: "proposal" },
  { key: "v_closed", label: "Verified closed", segment: "verify" },
  { key: "v_reopened", label: "Reopened", segment: "verify" },
  { key: "v_attention", label: "Needs attention", segment: "verify" },
  { key: "v_awaiting", label: "Awaiting check", segment: "verify" }
];

// The provider-fanned AI work queues (C11): queue name → the (job type,
// provider) pair the Insights AI-usage chart groups by. Derived from the
// catalog — the same source the broker provisions queues from — so the
// mapping can never drift from the real queue names. Dead-letter twins and
// non-provider queues (github/local-git/maintenance) are excluded: only
// provider work spends model tokens.
const AI_USAGE_QUEUES: ReadonlyMap<string, { jobType: string; provider: string }> = new Map(
  allQueueDefinitions().flatMap((queue): Array<[string, { jobType: string; provider: string }]> =>
    !queue.deadLetter && isAiProviderName(queue.capability)
      ? [[queue.name, { jobType: queue.type, provider: queue.capability }]]
      : []
  )
);

// The four confidence buckets, mapping each to its count column prefix and node.
const JOURNEY_CONFIDENCE = [
  { suffix: "high", node: "conf_high" },
  { suffix: "medium", node: "conf_medium" },
  { suffix: "low", node: "conf_low" },
  { suffix: "unknown", node: "conf_unknown" }
] as const;

// Assemble the Sankey payload from the flat count row the journey query returns.
// Reads each count as a number, builds the directed links, drops any with value
// 0, and includes only the nodes those links reference. Pure and DB-free so it is
// unit-testable without Postgres.
function buildJourney(row: Record<string, string> | undefined): JourneySankey {
  const n = (key: string): number => Number(row?.[key] ?? 0);

  const links: JourneyLink[] = [];
  for (const { suffix, node } of JOURNEY_CONFIDENCE) {
    links.push({ source: "questions", target: node, value: n(`q_${suffix}`) });
    links.push({ source: node, target: "no_gap", value: n(`nogap_${suffix}`) });
    // The unit shifts here: confidence → "gaps" is counted in gaps raised (not
    // questions), so the gap segment below stays internally conserved.
    links.push({ source: node, target: "gaps", value: n(`gaps_${suffix}`) });
  }
  links.push({ source: "gaps", target: "gap_dismissed", value: n("gap_dismissed") });
  links.push({ source: "gaps", target: "gap_parked", value: n("gap_parked") });
  links.push({ source: "gaps", target: "gap_open", value: n("gap_open") });
  links.push({ source: "gaps", target: "clustered", value: n("gap_clustered") });
  // The clustered → proposals link is the gap→proposal boundary, so it carries the
  // gap-side count (gap_clustered): the number of clustered gaps handed off, not the
  // proposal count. This keeps "Clustered" internally conserved (in = out) so its bar
  // reflects clustered gaps rather than ballooning to prop_total — a Sankey node is
  // sized by max(in, out). The unit shift then surfaces at "Proposals drafted", whose
  // outgoing status links sum to prop_total, matching the caption ("gaps become
  // proposals at Proposals drafted"). Proposals are windowed independently on their own
  // created_at, so prop_total is not conserved against gap_clustered by design.
  links.push({ source: "clustered", target: "proposals", value: n("gap_clustered") });
  links.push({ source: "proposals", target: "prop_inprogress", value: n("prop_inprogress") });
  links.push({ source: "proposals", target: "prop_rejected", value: n("prop_rejected") });
  links.push({ source: "proposals", target: "prop_superseded", value: n("prop_superseded") });
  links.push({ source: "proposals", target: "merged", value: n("prop_merged") });
  links.push({ source: "merged", target: "v_closed", value: n("v_closed") });
  links.push({ source: "merged", target: "v_reopened", value: n("v_reopened") });
  links.push({ source: "merged", target: "v_attention", value: n("v_attention") });
  links.push({ source: "merged", target: "v_awaiting", value: n("v_awaiting") });

  const positive = links.filter((link) => link.value > 0);
  const referenced = new Set<string>();
  for (const link of positive) {
    referenced.add(link.source);
    referenced.add(link.target);
  }
  const nodes = JOURNEY_NODES.filter((node) => referenced.has(node.key));
  return { nodes, links: positive };
}

export class PostgresInsightsStore implements InsightsStore {
  // `pgBossSchema` is the schema pg-boss stores its `job` table in. It is
  // interpolated into SQL (pg identifiers cannot be parameterised), so it is
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
  // pg-boss v12 keeps every job — live *and* finished — in the partitioned
  // "<schema>".job table; a completed/failed row stays there until pg-boss's
  // retention (`keep_until`) purges it. There is no separate `archive` table (it
  // was removed in pg-boss v10), so `job` alone holds all history within the
  // retention window. `type`, when given, narrows to specific pg-boss queue names
  // (resolved from a JobType by the service layer); it is matched with `= ANY($4)`
  // so it never touches SQL text.
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

  // Branching question-journey Sankey. Every link value is a real count; the
  // graph shows where volume leaks at each stage rather than only the narrowing
  // trunk a funnel shows. Four segments, each windowed on its own entry timestamp
  // (mirroring the funnel's per-stage windowing):
  //
  //   answer   — questions.asked_at, split by questions.confidence, then each
  //              confidence into "no gap" (0 question_gaps rows) or into the gap
  //              segment (counted in gaps, not questions — see the unit note).
  //   gap      — question_gaps.created_at, partitioned into mutually exclusive
  //              terminal arms: dismissed (dismissed_at), parked (parked_at),
  //              clustered (active gap_cluster_memberships OR resolved_at — the
  //              resolved gaps reached their outcome via the cluster→proposal
  //              path), or open (none of the above).
  //   proposal — proposals.created_at, split by proposals.status into in-progress
  //              (draft/ready/branch-pushed/pr-opened), rejected, superseded, or
  //              merged. The gap→proposal boundary link (clustered → proposals) carries
  //              the gap-side count so "Clustered" stays conserved; the unit shift to
  //              prop_total surfaces at "Proposals drafted" (see buildJourney).
  //   verify   — merged proposals split by proposals.closure_status: verified
  //              closed, reopened, needs attention, or awaiting check (NULL).
  //
  // The unit of flow shifts question → gap → proposal at the segment boundaries
  // (one question can raise many gaps; one cluster can yield many proposals).
  // Each segment is internally conserved; the chart labels the boundaries. Flow
  // filter narrows questions/gaps via questions.flow_id and proposals via
  // proposals.flow_id, exactly as the old funnel did.
  async journey(range: InsightsRange, flowId?: string): Promise<JourneySankey> {
    const result = await this.pool.query<Record<string, string>>(
      `
      WITH params AS (
        SELECT $1::timestamptz AS from_ts, $2::timestamptz AS to_ts, $3::text AS flow
      ),
      q AS (
        SELECT coalesce(qq.confidence, 'unknown') AS confidence,
               (SELECT count(*) FROM question_gaps gg WHERE gg.question_id = qq.id) AS gap_count
        FROM questions qq, params
        WHERE qq.asked_at >= params.from_ts AND qq.asked_at < params.to_ts
          AND (params.flow IS NULL OR qq.flow_id = params.flow)
      ),
      g AS (
        SELECT coalesce(qq.confidence, 'unknown') AS confidence,
               gg.dismissed_at, gg.parked_at, gg.resolved_at,
               EXISTS (
                 SELECT 1 FROM gap_cluster_memberships m WHERE m.gap_id = gg.id AND m.active
               ) AS clustered
        FROM question_gaps gg
        JOIN questions qq ON qq.id = gg.question_id, params
        WHERE gg.created_at >= params.from_ts AND gg.created_at < params.to_ts
          AND (params.flow IS NULL OR qq.flow_id = params.flow)
      ),
      p AS (
        SELECT pp.status, pp.closure_status
        FROM proposals pp, params
        WHERE pp.created_at >= params.from_ts AND pp.created_at < params.to_ts
          AND (params.flow IS NULL OR pp.flow_id = params.flow)
      )
      SELECT
        (SELECT count(*) FROM q WHERE confidence = 'high')                                  AS q_high,
        (SELECT count(*) FROM q WHERE confidence = 'medium')                                AS q_medium,
        (SELECT count(*) FROM q WHERE confidence = 'low')                                   AS q_low,
        (SELECT count(*) FROM q WHERE confidence NOT IN ('high','medium','low'))            AS q_unknown,
        (SELECT count(*) FROM q WHERE confidence = 'high'   AND gap_count = 0)              AS nogap_high,
        (SELECT count(*) FROM q WHERE confidence = 'medium' AND gap_count = 0)              AS nogap_medium,
        (SELECT count(*) FROM q WHERE confidence = 'low'    AND gap_count = 0)              AS nogap_low,
        (SELECT count(*) FROM q WHERE confidence NOT IN ('high','medium','low') AND gap_count = 0) AS nogap_unknown,
        (SELECT count(*) FROM g WHERE confidence = 'high')                                  AS gaps_high,
        (SELECT count(*) FROM g WHERE confidence = 'medium')                                AS gaps_medium,
        (SELECT count(*) FROM g WHERE confidence = 'low')                                   AS gaps_low,
        (SELECT count(*) FROM g WHERE confidence NOT IN ('high','medium','low'))            AS gaps_unknown,
        (SELECT count(*) FROM g WHERE dismissed_at IS NOT NULL)                             AS gap_dismissed,
        (SELECT count(*) FROM g WHERE dismissed_at IS NULL AND parked_at IS NOT NULL)       AS gap_parked,
        (SELECT count(*) FROM g WHERE dismissed_at IS NULL AND parked_at IS NULL
                                  AND (clustered OR resolved_at IS NOT NULL))               AS gap_clustered,
        (SELECT count(*) FROM g WHERE dismissed_at IS NULL AND parked_at IS NULL
                                  AND NOT clustered AND resolved_at IS NULL)                AS gap_open,
        (SELECT count(*) FROM p)                                                            AS prop_total,
        (SELECT count(*) FROM p WHERE status IN ('draft','ready','branch-pushed','pr-opened')) AS prop_inprogress,
        (SELECT count(*) FROM p WHERE status = 'rejected')                                  AS prop_rejected,
        (SELECT count(*) FROM p WHERE status = 'superseded')                                AS prop_superseded,
        (SELECT count(*) FROM p WHERE status = 'merged')                                    AS prop_merged,
        (SELECT count(*) FROM p WHERE status = 'merged' AND closure_status = 'verified_closed')  AS v_closed,
        (SELECT count(*) FROM p WHERE status = 'merged' AND closure_status = 'reopened')         AS v_reopened,
        (SELECT count(*) FROM p WHERE status = 'merged' AND closure_status = 'needs_attention')  AS v_attention,
        (SELECT count(*) FROM p WHERE status = 'merged' AND closure_status IS NULL)              AS v_awaiting
      `,
      [range.from.toISOString(), range.to.toISOString(), flowId ?? null]
    );

    return buildJourney(result.rows[0]);
  }

  // Answer-latency histogram (C4). Reads pg-boss's `job` table (completed
  // answer_question rows stay there until retention purges them; pg-boss v12 has no
  // separate `archive` table), measures each completed answer's end-to-end duration
  // (completed_on - created_on), and bins it into the fixed LATENCY_BINS.
  // `created_on` is used for the window filter
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
  // `split_part(name, '__', 1)` recovers the base job type. Failed rows stay in the
  // partitioned `job` table until retention purges them (pg-boss v12 has no separate
  // `archive` table), so `job` alone holds them. Ordered most-frequent-first.
  // The window filters on `created_on` (when the job was enqueued), not on failure
  // time, matching C2 `jobThroughput`'s creation-time axis; jobs fail shortly after
  // creation, so the two are effectively the same over a 30-day window.
  async jobErrors(range: InsightsRange): Promise<JobErrorSplit> {
    const result = await this.pool.query<{ dim: "category" | "type"; key: string; count: string }>(
      `
      WITH jobs AS (
        SELECT name, state, output, created_on FROM "${this.pgBossSchema}".job
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

  // Answer feedback (C10). Splits live questions' helpful/unhelpful feedback per
  // time bucket (windowed on feedback_at — when the user weighed in), with the
  // unhelpful-on-confident subset called out: an 'unhelpful' on a high/medium
  // answer is the strongest quality signal (#241). A question's feedback column
  // is single-valued and mutable (the latest verdict replaces earlier ones), so
  // the chart reflects each question's CURRENT verdict, bucketed by when it was
  // last given. Verification re-asks (purpose != 'live') are synthetic and never
  // receive feedback, but are excluded anyway for symmetry with the other
  // question-scoped aggregates. Buckets are zero-filled across the range.
  async answerFeedback(range: InsightsRange, flowId?: string): Promise<AnswerFeedback> {
    const unit = UNIT[range.bucket];
    const result = await this.pool.query<{
      bucket_start: Date;
      helpful: string;
      unhelpful: string;
      unhelpful_confident: string;
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
      f AS (
        SELECT date_trunc($3, feedback_at) AS b,
          count(*) FILTER (WHERE feedback = 'helpful')   AS helpful,
          count(*) FILTER (WHERE feedback = 'unhelpful') AS unhelpful,
          count(*) FILTER (
            WHERE feedback = 'unhelpful' AND confidence IN ('high', 'medium')
          ) AS unhelpful_confident
        FROM questions
        WHERE feedback IS NOT NULL AND feedback_at IS NOT NULL
          AND feedback_at >= $1::timestamptz AND feedback_at <= $2::timestamptz
          AND purpose = 'live'
          AND ($4::text IS NULL OR flow_id = $4)
        GROUP BY 1
      )
      SELECT b.b AS bucket_start,
        coalesce(f.helpful, 0)             AS helpful,
        coalesce(f.unhelpful, 0)           AS unhelpful,
        coalesce(f.unhelpful_confident, 0) AS unhelpful_confident
      FROM buckets b
      LEFT JOIN f ON f.b = b.b
      ORDER BY b.b
      `,
      [range.from.toISOString(), range.to.toISOString(), unit, flowId ?? null]
    );

    const series: FeedbackBucket[] = result.rows.map((row) => ({
      bucketStart: row.bucket_start.toISOString(),
      helpful: Number(row.helpful),
      unhelpful: Number(row.unhelpful),
      unhelpfulConfident: Number(row.unhelpful_confident)
    }));
    const totals = series.reduce(
      (acc, bucket) => ({
        helpful: acc.helpful + bucket.helpful,
        unhelpful: acc.unhelpful + bucket.unhelpful,
        unhelpfulConfident: acc.unhelpfulConfident + bucket.unhelpfulConfident
      }),
      { helpful: 0, unhelpful: 0, unhelpfulConfident: 0 }
    );
    return { totals, series };
  }

  // AI token usage (C11, #241). Sums the watcher-reported usage persisted on
  // completed jobs' `{ result, executor, usage, provider?, model? }` envelopes,
  // grouped per AI work queue AND per reported `model`, and mapped to (job type,
  // provider) via the catalog-derived AI_USAGE_QUEUES. `jobs` counts every
  // completed job on the queue in the window; `jobs_with_usage` counts the
  // subset that reported usage (CLI providers report nothing), so the chart can
  // say how much spend is unmetered. Windowed on `created_on`, matching C2/C6's
  // creation-time axis; completed rows stay in the partitioned `job` table until
  // retention purges them (pg-boss v12 has no separate `archive` table). Ordered
  // by total tokens, heaviest first.
  //
  // `estimatedCost` is computed at read time from the token sums × the current
  // `pricing` table (never persisted), and is only present for a triple whose
  // (provider, model) a price entry matches — the *priced* state. A row with
  // reported usage but no matching entry (*unpriced*) or with no reported usage
  // at all (*unmetered*, the CLI case) carries no cost, and the caller keeps the
  // two apart via `jobsWithUsage`.
  //
  // The LATERAL projects the small usage object and the flat model field out of
  // `output` ONCE per row: completion envelopes carry the whole job result
  // (drafted documents, answer traces — routinely tens of KB, TOASTed), and
  // referencing `output->...` in each aggregate would detoast the full envelope
  // once per expression. A row's total falls back to input+output when no
  // totalTokens was reported, so a provider that reports only input/output still
  // ranks by real spend.
  async aiUsage(range: InsightsRange, pricing: AiPricingEntry[]): Promise<AiUsageBreakdown[]> {
    const queueNames = [...AI_USAGE_QUEUES.keys()];
    const result = await this.pool.query<{
      name: string;
      model: string | null;
      jobs: string;
      jobs_with_usage: string;
      input_tokens: string;
      output_tokens: string;
      total_tokens: string;
    }>(
      `
      WITH usage_rows AS (
        SELECT j.name,
          u.model,
          u.usage,
          CASE WHEN jsonb_typeof(u.usage->'inputTokens') = 'number'
            THEN (u.usage->>'inputTokens')::bigint ELSE 0 END AS input_tokens,
          CASE WHEN jsonb_typeof(u.usage->'outputTokens') = 'number'
            THEN (u.usage->>'outputTokens')::bigint ELSE 0 END AS output_tokens
        FROM "${this.pgBossSchema}".job j
        CROSS JOIN LATERAL (SELECT j.output->'usage' AS usage, j.output->>'model' AS model) u
        WHERE j.state = 'completed'
          AND j.name = ANY($3)
          AND j.created_on >= $1::timestamptz AND j.created_on <= $2::timestamptz
      )
      SELECT name, model,
        count(*) AS jobs,
        count(*) FILTER (WHERE jsonb_typeof(usage) = 'object') AS jobs_with_usage,
        coalesce(sum(input_tokens), 0) AS input_tokens,
        coalesce(sum(output_tokens), 0) AS output_tokens,
        coalesce(sum(
          CASE WHEN jsonb_typeof(usage->'totalTokens') = 'number'
            THEN (usage->>'totalTokens')::bigint
            ELSE input_tokens + output_tokens END
        ), 0) AS total_tokens
      FROM usage_rows
      GROUP BY name, model
      `,
      [range.from.toISOString(), range.to.toISOString(), queueNames]
    );

    return result.rows
      .flatMap((row) => {
        const queue = AI_USAGE_QUEUES.get(row.name);
        return queue ? [this.priceUsageRow(queue, row, null, pricing)] : [];
      })
      .sort(
        (a, b) =>
          b.totalTokens - a.totalTokens ||
          b.jobs - a.jobs ||
          a.jobType.localeCompare(b.jobType) ||
          (a.model ?? "").localeCompare(b.model ?? "")
      );
  }

  // Per-flow AI usage (the per-flow cost view + per-schedule attribution). The
  // same rollup as aiUsage, additionally grouped by the flowId the enqueuing code
  // stamped on the job input — `data->'input'->>'flowId'`, where `data` is the
  // pg-boss JobEnvelope `{ type, input, traceContext }`. Rows whose input carried
  // no flowId group under a NULL flow (the "unattributed" bucket): `answer_question`
  // and the fold_* jobs never carry one, and the patrol/draft jobs omit it on the
  // unscoped flow. Each returned row is one (flowId, job type, provider, model)
  // triple with its priced estimatedCost; the service aggregates them per flow or
  // per schedule. Ordered by flow then heaviest spend.
  async aiUsageByFlow(range: InsightsRange, pricing: AiPricingEntry[]): Promise<AiUsageBreakdown[]> {
    const queueNames = [...AI_USAGE_QUEUES.keys()];
    const result = await this.pool.query<{
      name: string;
      model: string | null;
      flow_id: string | null;
      jobs: string;
      jobs_with_usage: string;
      input_tokens: string;
      output_tokens: string;
      total_tokens: string;
    }>(
      `
      WITH usage_rows AS (
        SELECT j.name,
          u.model,
          u.flow_id,
          u.usage,
          CASE WHEN jsonb_typeof(u.usage->'inputTokens') = 'number'
            THEN (u.usage->>'inputTokens')::bigint ELSE 0 END AS input_tokens,
          CASE WHEN jsonb_typeof(u.usage->'outputTokens') = 'number'
            THEN (u.usage->>'outputTokens')::bigint ELSE 0 END AS output_tokens
        FROM "${this.pgBossSchema}".job j
        CROSS JOIN LATERAL (
          SELECT j.output->'usage' AS usage,
                 j.output->>'model' AS model,
                 j.data->'input'->>'flowId' AS flow_id
        ) u
        WHERE j.state = 'completed'
          AND j.name = ANY($3)
          AND j.created_on >= $1::timestamptz AND j.created_on <= $2::timestamptz
      )
      SELECT name, model, flow_id,
        count(*) AS jobs,
        count(*) FILTER (WHERE jsonb_typeof(usage) = 'object') AS jobs_with_usage,
        coalesce(sum(input_tokens), 0) AS input_tokens,
        coalesce(sum(output_tokens), 0) AS output_tokens,
        coalesce(sum(
          CASE WHEN jsonb_typeof(usage->'totalTokens') = 'number'
            THEN (usage->>'totalTokens')::bigint
            ELSE input_tokens + output_tokens END
        ), 0) AS total_tokens
      FROM usage_rows
      GROUP BY name, model, flow_id
      `,
      [range.from.toISOString(), range.to.toISOString(), queueNames]
    );

    return result.rows
      .flatMap((row) => {
        const queue = AI_USAGE_QUEUES.get(row.name);
        return queue ? [this.priceUsageRow(queue, row, row.flow_id, pricing)] : [];
      })
      .sort(
        (a, b) =>
          (a.flowId ?? "").localeCompare(b.flowId ?? "") ||
          b.totalTokens - a.totalTokens ||
          a.jobType.localeCompare(b.jobType) ||
          (a.model ?? "").localeCompare(b.model ?? "")
      );
  }

  // Assemble one priced AiUsageBreakdown row from a grouped SQL row. Shared by the
  // C11 (flow-agnostic) and per-flow rollups: cost is a function of provider +
  // model only, so a NULL model or an unmatched (provider, model) yields no
  // estimatedCost — the caller keeps priced/unpriced/unmetered apart via
  // jobsWithUsage. flowId is threaded through only for the per-flow rollup.
  private priceUsageRow(
    queue: { jobType: string; provider: string },
    row: {
      model: string | null;
      jobs: string;
      jobs_with_usage: string;
      input_tokens: string;
      output_tokens: string;
      total_tokens: string;
    },
    flowId: string | null,
    pricing: AiPricingEntry[]
  ): AiUsageBreakdown {
    const inputTokens = Number(row.input_tokens);
    const outputTokens = Number(row.output_tokens);
    const estimatedCost = estimateTokenCost(
      pricing,
      { provider: queue.provider, model: row.model },
      {
        inputTokens,
        outputTokens
      }
    );
    return {
      jobType: queue.jobType,
      provider: queue.provider,
      ...(row.model !== null ? { model: row.model } : {}),
      ...(flowId !== null ? { flowId } : {}),
      jobs: Number(row.jobs),
      jobsWithUsage: Number(row.jobs_with_usage),
      inputTokens,
      outputTokens,
      totalTokens: Number(row.total_tokens),
      ...(estimatedCost !== undefined ? { estimatedCost } : {})
    };
  }
}
