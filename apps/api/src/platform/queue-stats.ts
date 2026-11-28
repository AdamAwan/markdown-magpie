import { JOB_TYPES, allQueueDefinitions } from "@magpie/jobs";
import { registerQueueMetrics, type QueueStatsSnapshot, type QueueStatsSource } from "@magpie/telemetry";
import type { AppContext } from "../context.js";
import { DEFAULT_PGBOSS_SCHEMA, SCHEMA_IDENTIFIER, publicScheduleKey } from "../jobs/pg-boss-broker.js";
import { logger } from "../logger.js";

// Queue-health metrics (docs/observability.md O16–O22): dead-letter depth,
// oldest claimable job age, connected watchers, and time since each schedule's
// last successful run. Everything is read in ONE SQL statement per metric
// collection (OTEL_METRIC_EXPORT_INTERVAL, 60 s by default; at most once per
// 15 s however it is configured), and only when telemetry is on — with it off the
// OTel meter is a no-op and never asks for a snapshot. The values are queue-wide,
// so N API replicas report N identical copies; aggregate with max().

// The slice of pg.Pool the reader uses (a pg.Pool satisfies it).
interface StatsPool {
  readonly ended: boolean;
  query(sql: string, values: unknown[]): Promise<{ rows: StatsRow[] }>;
}

export interface QueueStatsReaderOptions {
  pool: StatsPool;
  pgBossSchema: string;
  // A watcher counts as connected when it claimed or heartbeated within this
  // window — the same window the Jobs screen's worker list uses.
  watcherActiveWindowMs: number;
}

interface StatsRow {
  kind: "queue" | "watchers" | "capability" | "schedule";
  k1: string | null;
  k2: string | null;
  a: number | null;
  b: number | null;
}

const queues = allQueueDefinitions();
const workQueueNames = queues.filter((queue) => !queue.deadLetter).map((queue) => queue.name);
const deadLetterQueueNames = queues.filter((queue) => queue.deadLetter).map((queue) => queue.name);
const queueTypes = new Map(queues.map((queue) => [queue.name, queue.type]));
const CAPABILITIES = [...new Set(queues.flatMap((queue) => (queue.capability ? [queue.capability] : [])))].sort();

// The single grouped statement. Parameters: $1 work queue names, $2 dead-letter
// queue names, $3 the watcher active window in ms. Only the (regex-guarded)
// pg-boss schema is interpolated. Row kinds:
//   queue      k1 = queue name, a = ready (claimable now), b = oldest ready age (s)
//              — for a dead-letter queue, a = parked jobs and b is unused
//   watchers   a = connected watchers
//   capability k1 = capability, a = connected watchers advertising it
//   schedule   k1 = pg-boss schedule key, k2 = job type,
//              a = seconds since last completed run (since creation if none)
function statsSql(schema: string): string {
  return `
    WITH waiting AS (
      SELECT name,
        count(*) FILTER (WHERE start_after <= now() OR name = ANY($2)) AS ready,
        extract(epoch FROM now() - min(start_after) FILTER (WHERE start_after <= now())) AS oldest
      FROM "${schema}".job
      WHERE state IN ('created', 'retry') AND (name = ANY($1) OR name = ANY($2))
      GROUP BY name
    ),
    live_watchers AS (
      SELECT capabilities FROM watcher_registrations
      WHERE last_seen_at >= now() - ($3::double precision * interval '1 millisecond')
    ),
    schedules AS (
      SELECT s.key, s.data->>'type' AS job_type, s.created_on,
        (SELECT max(j.completed_on) FROM "${schema}".job j
          WHERE j.name = s.name AND j.state = 'completed'
            AND j.data->'input' IS NOT DISTINCT FROM s.data->'input') AS last_success
      FROM "${schema}".schedule s
      WHERE s.data ? 'type'
    )
    SELECT 'queue' AS kind, name AS k1, NULL::text AS k2, ready::float8 AS a, coalesce(oldest, 0)::float8 AS b
      FROM waiting
    UNION ALL
    SELECT 'watchers', NULL, NULL, count(*)::float8, NULL FROM live_watchers
    UNION ALL
    SELECT 'capability', capability, NULL, count(*)::float8, NULL
      FROM live_watchers, unnest(capabilities) AS capability GROUP BY capability
    UNION ALL
    SELECT 'schedule', key, job_type, extract(epoch FROM now() - coalesce(last_success, created_on))::float8, NULL
      FROM schedules
  `;
}

export function createQueueStatsReader(options: QueueStatsReaderOptions): QueueStatsSource {
  if (!SCHEMA_IDENTIFIER.test(options.pgBossSchema)) {
    throw new Error(`Invalid pg-boss schema name: ${options.pgBossSchema}`);
  }
  const sql = statsSql(options.pgBossSchema);
  return async () => {
    // The shutdown sequence ends the pool before telemetry's final flush, which
    // runs one last collection: report nothing rather than query a closed pool.
    if (options.pool.ended) return undefined;
    const result = await options.pool.query(sql, [workQueueNames, deadLetterQueueNames, options.watcherActiveWindowMs]);
    return toSnapshot(result.rows);
  };
}

function toSnapshot(rows: StatsRow[]): QueueStatsSnapshot {
  const byType = new Map(
    JOB_TYPES.map((jobType) => [jobType, { jobType, ready: 0, oldestReadyAgeSeconds: 0, deadLetter: 0 }])
  );
  const capabilityCounts = new Map<string, number>(CAPABILITIES.map((capability) => [capability, 0]));
  const deadLetterNames = new Set(deadLetterQueueNames);
  let connected = 0;
  const schedules: Array<QueueStatsSnapshot["schedules"][number]> = [];

  for (const row of rows) {
    const a = Number(row.a ?? 0);
    if (row.kind === "queue" && row.k1) {
      const type = queueTypes.get(row.k1);
      const entry = type ? byType.get(type) : undefined;
      if (!entry) continue;
      if (deadLetterNames.has(row.k1)) {
        entry.deadLetter += a;
      } else {
        entry.ready += a;
        entry.oldestReadyAgeSeconds = Math.max(entry.oldestReadyAgeSeconds, Number(row.b ?? 0));
      }
    } else if (row.kind === "watchers") {
      connected = a;
    } else if (row.kind === "capability" && row.k1) {
      // A capability no longer in the catalog (an old watcher build) is still
      // reported: it is real, if unroutable, reach.
      capabilityCounts.set(row.k1, a);
    } else if (row.kind === "schedule" && row.k1) {
      schedules.push({ key: publicScheduleKey(row.k1), jobType: row.k2 ?? "unknown", lastSuccessAgeSeconds: a });
    }
  }

  return {
    jobTypes: [...byType.values()],
    watchers: {
      connected,
      byCapability: [...capabilityCounts].map(([capability, count]) => ({ capability, connected: count }))
    },
    schedules: schedules.sort((left, right) => left.key.localeCompare(right.key))
  };
}

// Composition-root hook: registers the queue-health gauges against the API's
// shared pool. Returns the disposer (a no-op without a Postgres pool).
export function startQueueMetrics(ctx: Pick<AppContext, "pool" | "settings">): () => void {
  if (!ctx.pool) return () => undefined;
  const source = createQueueStatsReader({
    pool: ctx.pool,
    pgBossSchema: DEFAULT_PGBOSS_SCHEMA,
    watcherActiveWindowMs: ctx.settings.watcher.activeWindowMs
  });
  return registerQueueMetrics(source, {
    onError: (error) =>
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "queue metrics read failed")
  });
}
