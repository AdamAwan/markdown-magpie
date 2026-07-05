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

  // Implemented in a later task (C1).
  async funnel(): Promise<FunnelStage[]> {
    return [];
  }
}
