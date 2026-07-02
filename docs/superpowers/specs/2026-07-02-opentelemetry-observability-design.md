# OpenTelemetry observability — design

Date: 2026-07-02
Status: Approved (brainstorming) — pending spec review
Issue: [#85](https://github.com/AdamAwan/markdown-magpie/issues/85) (remaining gaps 1 & 2; supersedes the #120 correlation id)

## Motivation

#85 asked for metrics, error tracking, and crash handlers. [#120](https://github.com/AdamAwan/markdown-magpie/pull/120)
shipped the crash handlers (gap 3) and a hand-rolled cross-service correlation id (gap 4).
This spec completes the remaining gaps — **metrics** (gap 1) and **error tracking** (gap 2) —
and does so in a way that lets an operator use **any** backend, not a specific vendor.

The chosen mechanism is **OpenTelemetry (OTel)**: instrument the code once against the vendor-neutral
OTel API and export **OTLP**, which nearly every backend ingests (Grafana/Tempo/Mimir, Datadog,
Honeycomb, New Relic, Sentry-via-OTLP, or an OTel Collector that fans out to several — including a
Prometheus scrape endpoint). This keeps Magpie vendor-agnostic without us maintaining per-vendor code.

Because OTel tracing provides cross-service correlation natively (a real `trace_id` propagated across
services), the bespoke correlation-id system from #120 is **removed** rather than kept in parallel.

## Decisions (locked during brainstorming)

1. **OTel-native for everything** — traces *and* metrics over OTLP. No bespoke Prometheus scrape endpoint;
   an operator who wants Prometheus runs an OTel Collector with a Prometheus exporter.
2. **Off by default** — app code emits through the OTel *API* (a no-op until an SDK is registered). The SDK
   and exporters are started only when telemetry is explicitly configured. Zero runtime cost and zero new
   dependency loading when disabled.
3. **Fully remove the #120 correlation id** — no zero-config fallback. Cross-service correlation exists only
   when OTel is enabled (via `trace_id`). The default build has per-request `requestId` logging (pre-#120)
   but no cross-service correlation. This is an accepted tradeoff.

## Architecture

```
   App code (api, watcher)          OTel API (no-op unless SDK started)
  ┌───────────────────────┐        ┌──────────────────────────────────┐
  │ http handlers         │        │ trace.getTracer / metrics.getMeter│
  │ worker loop           │ ─────> │ propagation.inject / extract      │ ──┐
  │ job broker            │        │ span.recordException              │   │
  └───────────────────────┘        └──────────────────────────────────┘   │
                                                                            v
                              @magpie/telemetry  ── initTelemetry(config) ──> NodeSDK + OTLP exporters
                              (SDK bootstrap, gated by env; dynamic-imported)      │
                                                                                   v
                                                                        OTLP endpoint / Collector
                                                                        (Grafana, Datadog, Sentry, …)
```

### New package: `@magpie/telemetry`

Owns the OTel wiring so both apps share one implementation and the rest of the code depends only on the
lightweight OTel API.

- **`initTelemetry(config): Promise<TelemetryHandle>`** — the SDK bootstrap. When `config.enabled` is false
  it returns a no-op handle immediately and imports **nothing** heavy. When enabled it **dynamically imports**
  `@opentelemetry/sdk-node` and the exporters (so the SDK's dependency weight never loads in the default
  path), constructs a `NodeSDK` with:
  - a `resource` carrying `service.name` (`api` / `watcher`) and version,
  - OTLP trace + metric exporters (endpoint/headers from standard `OTEL_*` env),
  - HTTP/undici auto-instrumentation (server + client spans, and their `http.server.*` metrics) and pg
    instrumentation,
  - starts it, and returns a handle whose `shutdown()` flushes exporters on process shutdown.
- **`getMeterInstruments()`** — lazily-created counters/histograms/gauges (see Metrics) from
  `metrics.getMeter("magpie")`. Safe to call when disabled (records into the no-op meter).
- **`recordException(error, attributes?)`** — records the error on the active span and sets its status to
  ERROR. No-op when there is no active span (i.e. when disabled).
- **`loggerTraceMixin()`** — a pino mixin that stamps `trace_id`/`span_id` from the active span onto each
  log line, so logs are grepped/joined by trace. Returns `{}` when no span is active.

App code imports `@opentelemetry/api` directly for the handful of call sites that create spans or record
metrics; everything else flows through auto-instrumentation.

### Config (via the existing `loadConfig` path)

Telemetry config is validated at startup like all other env (per the startup-config-validation work), not
read ad hoc. Fields:

- **enabled** — true iff telemetry is configured. Trigger: `OTEL_EXPORTER_OTLP_ENDPOINT` is set (idiomatic:
  no endpoint ⇒ nothing to export), overridable by an explicit `MAGPIE_TELEMETRY_ENABLED=false`.
- Standard OTel env (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`,
  sampling vars, …) is honoured directly by the SDK; we do not re-invent it.

`main.ts` (api and watcher) calls `initTelemetry` **first**, before other wiring, and registers its
`shutdown()` in the existing graceful-shutdown path so buffered spans/metrics flush on exit.

## Traces

- **HTTP hops are automatic.** The API↔watcher callbacks and inbound requests are auto-instrumented; the
  client injects W3C `traceparent`, the server extracts it, so those hops join one trace with no manual code.
- **The queue boundary is manual.** OTel does not propagate context across a durable queue. So:
  - `broker.create()` calls `propagation.inject(context.active(), carrier)` and stores the carrier
    (`traceparent`/`tracestate`) on the job envelope.
  - The claim response surfaces that carrier on `JobView` (replacing `JobView.correlationId`).
  - The watcher's `execute()` calls `propagation.extract(...)` on the carrier and starts a `job.execute`
    span (attributes: `job.id`, `job.type`) as a child of the extracted context. The watcher's subsequent
    API callbacks run inside that span, so their auto-instrumented client spans continue the same trace.

Net: one trace spans **API request → enqueued job → watcher execution → API callback**, replacing the
hand-rolled id and header scheme.

## Metrics

Defined once in `@magpie/telemetry`; recorded from the code that already owns the events. Initial set:

| Instrument | Kind | Attributes | Recorded where |
| --- | --- | --- | --- |
| `magpie.jobs.finished` | counter | `type`, `outcome` (completed/failed/cancelled) | watcher worker-loop terminal transition |
| `magpie.jobs.duration` | histogram (ms) | `type`, `outcome` | watcher worker-loop (reuses existing `durationMs`) |
| `magpie.jobs.inflight` | observable gauge | `type` | callback over the broker's `countInFlight` for AI types |
| `http.server.*` | histogram/counter | method, route, status | **auto-instrumentation** (no custom code) |

Queue-depth-per-provider beyond the AI in-flight cap is deferred (the broker has no cheap all-queue count;
see #85). HTTP status/latency come free from auto-instrumentation, so no custom middleware is added for them.

## Error tracking

- **Handled errors** — the watcher's job `catch` and the API's `onError` call `recordException(err)`, so the
  error attaches to the active span with full trace context and ships via OTLP to whatever backend the
  operator runs (including Sentry via OTLP). No Sentry SDK, no vendor lock-in.
- **Fatal/uncaught** — already covered by the #120 crash handlers (structured fatal log + non-zero exit);
  unchanged. (The process is dying, so we keep logging rather than depend on an async exporter flush.)

Grouping/dedup/alerting are backend product features, intentionally out of our scope.

## Removal of the #120 correlation id

Deleted or reverted:

- `packages/logger`: `createCorrelationStore`, `CorrelationStore`, their tests. (Crash handlers stay.)
- `apps/api/src/platform/correlation.ts` and `apps/watcher/src/correlation.ts`: deleted.
- `apps/api/src/http/logging.ts`: drop `x-correlation-id` minting/echo and the ALS scope; **keep** the
  pre-#120 `requestId`. Add `loggerTraceMixin()` to the root logger so lines carry `trace_id` when a span is
  active.
- `apps/api/src/jobs/pg-boss-broker.ts` + `fake-broker.ts`: replace the envelope `correlationId` with the
  trace-context carrier and its inject/extract.
- `packages/jobs/src/types.ts`: replace `JobView.correlationId` with `JobView.traceContext?: Record<string,string>`.
- `apps/watcher/src/http-client.ts`: drop the `x-correlation-id` header (auto-instrumentation injects
  `traceparent` instead).
- `apps/watcher/src/worker-loop.ts`: drop `correlation.run`/binding; add the `job.execute` span + context
  extract.

## Error handling & safety

- **Telemetry must never break the app.** `initTelemetry` failures (bad endpoint, exporter init error) are
  caught, logged as a warning, and downgrade to disabled — the app runs normally. OTLP export failures are
  handled inside the SDK (retry/drop); they never surface to request/job paths.
- **No-op discipline.** Every helper is safe to call when disabled: `recordException` and the metrics
  instruments record into OTel no-ops, the mixin returns `{}`. So call sites need no `if (enabled)` guards.

## Testing

- `@magpie/telemetry`: init with an in-memory span exporter + in-memory metric reader; assert a span/metric
  is recorded when enabled and that the disabled path records nothing and imports no SDK.
- Queue propagation: unit-test `inject` → carrier → `extract` round-trips the same trace id.
- Logger mixin: with an active span, a log line carries `trace_id`; without one, it does not.
- Worker-loop: a claimed job with a carrier starts a child span; outcome metric + duration recorded.
- Existing suites updated for the correlation-id removal.

## Out of scope

- A bespoke Prometheus `/metrics` scrape endpoint (use an OTel Collector).
- A native Sentry SDK adapter (Sentry ingests OTLP).
- Shipping application logs via OTLP (logs stay on the existing pino → stdout → Loki/Grafana pipeline;
  only `trace_id` is added for joinability).
- Dashboards, alert rules, per-provider queue-depth metrics.

## Rollout

Off by default, so merging changes nothing operationally until an operator sets `OTEL_EXPORTER_OTLP_ENDPOINT`.
Documentation (`docs/architecture.md` Observability section + env docs) updated in the same change; the
"not yet implemented: metrics / error tracking" note is replaced with the OTel description.
