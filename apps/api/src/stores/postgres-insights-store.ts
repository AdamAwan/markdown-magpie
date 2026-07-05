import pg from "pg";
import type { FunnelStage, GapBacklogBucket, JobThroughputBucket } from "@magpie/core";
import type { InsightsRange, InsightsStore } from "./insights-store.js";

// date_trunc units, whitelisted so the bucket unit is never interpolated from
// unvalidated input (the zod schema also constrains it to these three).
const UNIT: Record<InsightsRange["bucket"], "day" | "week" | "month"> = {
  day: "day",
  week: "week",
  month: "month"
};

export class PostgresInsightsStore implements InsightsStore {
  constructor(private readonly pool: pg.Pool) {}

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

  // Implemented in a later task (C2). Returning an empty series keeps the
  // endpoint well-formed until then.
  async jobThroughput(): Promise<JobThroughputBucket[]> {
    return [];
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
}
