# Observability

> **Status:** living spec (as-built). Source of truth for structured logging, crash
> handling, tracing, metrics, error tracking, and health/liveness across both services.
> Follows the [spec conventions](./README.md#conventions).

## Purpose

Make the two-service system (API + watcher) debuggable in production: structured logs
correlated to one distributed trace when telemetry is on, vendor-neutral metrics, and
health endpoints for orchestrators. Observability is **off by default** and never allowed
to break the app.

## Structured logging

- **O1** — Both services log JSON via pino (`@magpie/logger`), each root logger bound to
  a `service` field (`api` / `watcher`). Default level is `info` in production, `debug`
  otherwise (`LOG_LEVEL` overrides); output is pretty only when `NODE_ENV !==
  "production"`. The logger package reads no env itself — the caller passes all config.
- **O2** — Every logger applies default **redaction** paths (authorization, apiKey,
  token, githubToken, password, client_secret) as defence-in-depth.
- **O3** — The API request middleware assigns each request a **child logger** bound to
  `{ requestId, method, path }` (`requestId = randomUUID()`) and logs one completion line
  with `{ status, durationMs }`. `requestId` is per-hop only — cross-service correlation
  comes from the trace id (O7), not a bespoke correlation header.
- **O4** — The watcher binds a **per-job child logger** `{ jobId, jobType }` and logs
  `job claimed` and a terminal `job done` / `job failed` / `job cancelled` with
  `{ durationMs, outcome }`.

## Crash handlers

- **O5** — Each entrypoint installs `installCrashHandlers` at its composition root before
  any work. An `uncaughtException` or `unhandledRejection` is logged **fatally** with
  structured context (`service`, `err` with stack, `event`), flushed best-effort, and the
  process exits non-zero exactly once — so the orchestrator's restart policy takes over
  instead of a bare stderr trace. Non-Error rejections are normalized to `Error` so the
  serializer and stack work.

## OpenTelemetry (off by default)

- **O6** — Telemetry is enabled **iff** `OTEL_EXPORTER_OTLP_ENDPOINT` is set **and**
  `MAGPIE_TELEMETRY_ENABLED` is not `"false"` (case-insensitive). Setting the endpoint is
  the master on-switch; `MAGPIE_TELEMETRY_ENABLED=false` force-disables even with an
  endpoint, and it cannot enable without one. When disabled, `initTelemetry` returns a
  no-op handle immediately and imports no SDK — the app emits through the lightweight OTel
  API, which is a no-op until the SDK starts.
- **O7** — When enabled, `initTelemetry` starts a `NodeSDK` with OTLP trace + metric
  exporters and HTTP/undici/pg auto-instrumentation, called **first** at each composition
  root (before HTTP/pg clients exist, so auto-instrumentation can patch them) and shut
  down last. A telemetry init failure is downgraded to disabled (logged `warn`), never
  thrown — telemetry MUST NOT stop the app.

## Correlation via trace context

- **O8** — With telemetry on, one **trace** threads the whole cross-service chain — API
  request → enqueued job → watcher execution → API callback. HTTP hops propagate W3C
  `traceparent` automatically (auto-instrumentation).
- **O9** — The **queue boundary is bridged manually**: the broker injects the active
  trace context onto the job envelope (`JobView.traceContext`, stored only when non-empty),
  and the watcher runs each job inside a span extracted from that carrier
  (`runJobSpan`) — joining job execution and its API callbacks into the originating trace.
- **O10** — Every log line carries `trace_id` / `span_id` via a pino mixin (empty when no
  active span). With telemetry off there is no cross-service correlation — only per-request
  `requestId` logging.

## Metrics

- **O11** — The watcher records `magpie.jobs.finished` (counter by `job.type` /
  `job.outcome`) and `magpie.jobs.duration` (histogram, ms) for every job reaching a
  terminal state, under the `@magpie/telemetry` meter. HTTP server latency/status metrics
  come from auto-instrumentation. Everything exports over **OTLP** — there is **no bespoke
  `/metrics` endpoint** (run an OTel Collector with a Prometheus exporter if a scrape
  endpoint is wanted).

## Queue-health metrics (stuck-queue alerting)

Counters on the watcher only say what *finished*. A queue that has stopped draining —
no watcher for a capability, a wedged watcher, a schedule that silently stopped firing —
produces no events at all, so it needs gauges read from the queue's own state.

- **O16** — With telemetry on (O6), the **API** registers six observable gauges on the
  `@magpie/telemetry` meter. The watcher registers none (it has no database access).

  | Gauge | Unit | Attributes | Value |
  | --- | --- | --- | --- |
  | `magpie.queue.ready` | `{job}` | `job.type` | Jobs a watcher could claim now (O18) |
  | `magpie.queue.oldest_ready_age` | `s` | `job.type` | How long the longest-waiting claimable job has waited; `0` when none |
  | `magpie.queue.dead_letter` | `{job}` | `job.type` | Jobs parked in the type's `__dead_letter` queues |
  | `magpie.watchers.connected` | `{watcher}` | — | Watchers seen within the active window (O19) |
  | `magpie.watchers.capability` | `{watcher}` | `watcher.capability` | Of those, how many advertise each capability |
  | `magpie.schedule.last_success_age` | `s` | `schedule.key`, `job.type` | Seconds since an enabled schedule's last completed run (O20) |

- **O17** — All six are fed by **one batch callback** that runs **one grouped SQL
  statement** per metric collection — every 60 s (`initTelemetry`'s periodic metric reader
  uses the SDK default interval; it does not read `OTEL_METRIC_EXPORT_INTERVAL`) — over
  existing tables only: pg-boss's `job` and `schedule` tables and `watcher_registrations`.
  A collection within **15 s** of the last successful read reuses that snapshot, and
  overlapping collections share one in-flight read, so no extra reader or forced flush can
  turn the gauges into a query storm. With telemetry off the API's meter is the OTel no-op,
  which never invokes the callback — **no query runs at all**. Per replica that is one
  query a minute: N replicas cost N queries a minute.
- **O18** — Queue gauges are reported for **every job type in the catalog, zero-filled**,
  summing a type's provider/destination fan-out queues. *Ready* means state `created` or
  `retry` with `start_after` reached — a job waiting out its retry backoff is not ready
  yet, so backoff alone never reads as a stuck queue. `oldest_ready_age` is
  `now − start_after` of the longest-waiting ready job (the max across the type's queues).
  `dead_letter` counts `created`/`retry` jobs in the `__dead_letter` twins: nothing
  consumes those queues, so a job stays counted until pg-boss retention deletes it (or an
  operator deals with it) — a non-zero value means retries were exhausted.
- **O19** — A watcher is *connected* when its `watcher_registrations.last_seen_at` falls
  within `WATCHER_ACTIVE_WINDOW_MS` (default 15 min — the same window as the Jobs screen's
  worker list; lower it for faster "no watchers" alerts). `magpie.watchers.capability` is
  zero-filled for every capability a catalog queue routes to. The gauges only read; they
  never prune the registry.
- **O20** — `magpie.schedule.last_success_age` has one series per enabled Magpie schedule
  in pg-boss, labelled with the public schedule key (`task:<taskKey>`, the key
  `GET /api/jobs/schedules` shows) and its job type. The value is the time since the most
  recent `completed` job on the schedule's queue **with the same input** (so a manual
  run-now of the same task counts as a success), or — when there is none, including when
  pg-boss retention has already purged every completed run — the time since the schedule
  was created. A schedule that has never succeeded therefore ages like one that stopped.
- **O21** — The values are **queue-wide**, not per process: every API replica reports the
  same numbers. Dashboards and alerts MUST combine replicas with `max` (never `sum`), and
  SHOULD alert on the series being absent, which is what a telemetry or database outage
  looks like.
- **O22** — A failed read is logged at `warn` (`queue metrics read failed`) and that
  collection observes **nothing** (a gap, never a misleading zero); it never throws into
  the SDK. During shutdown the pool is closed before telemetry's final flush, so that last
  collection is skipped silently instead of querying a closed pool.

### Example alert rules (Prometheus)

Through an OTel Collector's Prometheus exporter the gauges appear as
`magpie_queue_ready`, `magpie_queue_oldest_ready_age_seconds`, `magpie_queue_dead_letter`,
`magpie_watchers_connected`, `magpie_watchers_capability`, and
`magpie_schedule_last_success_age_seconds`, with dots in attribute names turned into
underscores (`job_type`, `watcher_capability`, `schedule_key`). Exact names depend on the
exporter's suffix settings; check your scrape before copying. Thresholds are starting
points — tune them to your cron cadences and traffic.

```yaml
groups:
  - name: magpie-queue
    rules:
      # An interactive ask has waited 2 minutes for any watcher to claim it.
      - alert: MagpieAnswerQueueStuck
        expr: max by (job_type) (magpie_queue_oldest_ready_age_seconds{job_type="answer_question"}) > 120
        for: 5m
      # Any other job type has had claimable work waiting 30 minutes.
      - alert: MagpieQueueStuck
        expr: max by (job_type) (magpie_queue_oldest_ready_age_seconds{job_type!="answer_question"}) > 1800
        for: 10m
      # New dead letters in the last hour: retries were exhausted.
      - alert: MagpieDeadLetters
        expr: max by (job_type) (delta(magpie_queue_dead_letter[1h])) > 0
      - alert: MagpieNoWatchers
        expr: max(magpie_watchers_connected) == 0
        for: 5m
      - alert: MagpieNoMaintenanceWatcher
        expr: max(magpie_watchers_capability{watcher_capability="maintenance"}) == 0
        for: 5m
      # No completed run for 3 hours (patrols are hourly, gaps→PR ~10 min).
      - alert: MagpieScheduleStale
        expr: max by (schedule_key, job_type) (magpie_schedule_last_success_age_seconds) > 10800
        for: 15m
      # The gauges themselves vanished: telemetry or the API's database read is down.
      - alert: MagpieQueueMetricsAbsent
        expr: absent(magpie_watchers_connected)
        for: 15m
```

## Error tracking

- **O12** — `recordException` attaches an error to the active span (sets status `ERROR`);
  it is a no-op when no span is active. It is called on unhandled API 500s (in the error
  handler, for non-HttpError/non-validation errors) and on watcher job failures. Handled
  errors (HttpError, validation) and cancellations/aborts do **not** record exceptions.

## Health / liveness

- **O13** — The **watcher** exposes a minimal HTTP server: `GET /health` (liveness — 200
  when the poll loop ticked within `WATCHER_HEALTH_STALE_AFTER_MS`, else 503 `stale`) and
  `GET /ready` (readiness — 200 iff it advertises ≥1 runnable capability, else 503).
- **O14** — The **API** also exposes health endpoints (auth-exempt): `GET /health`
  (shallow liveness), `GET /ready` (deep readiness — broker started **and** Postgres
  reachable, returning `{ ready, checks: { database, broker } }`), and `GET /version`.

## Startup config validation

- **O15** — Each service validates its env once at startup and throws a single aggregated
  error naming every offending variable, before starting the broker/server. Telemetry
  config is resolved by a helper (not the main schema) because OTel's env surface is large
  and standardized; watcher health config is validated fail-fast and separately.

## Key env vars

| Env var | Default | Effect |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Master on-switch for telemetry |
| `MAGPIE_TELEMETRY_ENABLED` | unset | `false` force-disables; cannot enable alone |
| `OTEL_SERVICE_NAME` | `api` / `watcher` | Service name override |
| `WATCHER_ACTIVE_WINDOW_MS` | `900000` | Window for "connected" in the watcher gauges (O19) |
| `LOG_LEVEL` | `info` (prod) / `debug` | Log level |
| `WATCHER_HEALTH_PORT` / `_HOST` / `_STALE_AFTER_MS` | 4002 / `0.0.0.0` / 120000 | Watcher health server |

## Code map

| Concern | Code |
| --- | --- |
| Logger + crash handlers | `packages/logger/src/index.ts` |
| Root loggers | `apps/api/src/logger.ts`, `apps/watcher/src/logger.ts` |
| Request logging | `apps/api/src/http/logging.ts` |
| Per-job logging | `apps/watcher/src/worker-loop.ts` |
| Telemetry (config/init/instruments/tracing) | `packages/telemetry/src/{config,init,instruments,tracing,logging}.ts` |
| Queue-health gauges (O16–O22) | `packages/telemetry/src/queue-metrics.ts` (gauges + cache), `apps/api/src/platform/queue-stats.ts` (the SQL read + wiring), `apps/api/src/main.ts` (`startQueueMetrics`) |
| Queue trace bridging | `apps/api/src/jobs/pg-boss-broker.ts` (inject), `apps/watcher/src/worker-loop.ts` (extract) |
| Error handler | `apps/api/src/http/errors.ts` |
| Health servers | `apps/watcher/src/health-server.ts`, `apps/api/src/app.ts` |

## Tests (behavioural contract)

`packages/logger/src/index.test.ts`,
`packages/telemetry/src/{config,init,instruments,tracing,queue-metrics}.test.ts`,
`apps/watcher/src/health-server.test.ts`, `apps/watcher/src/worker-loop.test.ts`,
`apps/api/src/http/{logging,errors}.test.ts`, `apps/api/src/platform/queue-stats.test.ts`,
and `apps/api/src/platform/queue-stats.integration.test.ts` (the stats SQL against a real
pg-boss schema; `RUN_PG_INTEGRATION`, run by `npm run test:db`).

## Provenance (design history)

Consolidates: `docs/superpowers/specs/2026-06-30-structured-logging-design.md`,
`2026-06-30-unified-logging-design.md`,
`2026-07-02-opentelemetry-observability-design.md` (the end state — its OTel trace id
supersedes the earlier bespoke correlation-id), and the two startup-config-validation
designs (`2026-06-30-api-…`, `2026-07-01-watcher-…`). The queue-health gauges (O16–O22)
were added in the pre-launch audit with no separate design doc; this section is their
spec.

> **Drift found while writing:** the pre-OTel bespoke correlation-id from the earlier
> logging designs is **gone** — cross-service correlation is now the OTel trace id, and
> `apps/api/src/http/logging.ts` states this explicitly. Separately, `architecture.md`'s
> Health section mentions only the watcher's `/health` and `/ready` and omits that the
> API also exposes `/health`, `/ready`, and `/version` (O14) — a doc understatement, now
> corrected here.
