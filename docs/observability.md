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
| Queue trace bridging | `apps/api/src/jobs/pg-boss-broker.ts` (inject), `apps/watcher/src/worker-loop.ts` (extract) |
| Error handler | `apps/api/src/http/errors.ts` |
| Health servers | `apps/watcher/src/health-server.ts`, `apps/api/src/app.ts` |

## Tests (behavioural contract)

`packages/logger/src/index.test.ts`,
`packages/telemetry/src/{config,init,instruments,tracing}.test.ts`,
`apps/watcher/src/health-server.test.ts`, `apps/watcher/src/worker-loop.test.ts`,
`apps/api/src/http/{logging,errors}.test.ts`.

## Provenance (design history)

Consolidates: `docs/superpowers/specs/2026-06-30-structured-logging-design.md`,
`2026-06-30-unified-logging-design.md`,
`2026-07-02-opentelemetry-observability-design.md` (the end state — its OTel trace id
supersedes the earlier bespoke correlation-id), and the two startup-config-validation
designs (`2026-06-30-api-…`, `2026-07-01-watcher-…`).

> **Drift found while writing:** the pre-OTel bespoke correlation-id from the earlier
> logging designs is **gone** — cross-service correlation is now the OTel trace id, and
> `apps/api/src/http/logging.ts` states this explicitly. Separately, `architecture.md`'s
> Health section mentions only the watcher's `/health` and `/ready` and omits that the
> API also exposes `/health`, `/ready`, and `/version` (O14) — a doc understatement, now
> corrected here.
