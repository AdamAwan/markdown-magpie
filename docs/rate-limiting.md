# Rate limiting & AI cost controls

The API throttles expensive, metered work so a single authenticated caller
cannot run up unbounded AI spend or starve the queue. There are two independent
layers, both configured from environment variables and both emitting structured
log events for dashboards.

## L1 — per-principal request rate limiting

A Hono middleware (`apps/api/src/http/rate-limit.ts`) applied to the metered
endpoints. It keys a **fixed-window counter** on the authenticated principal
(`Principal.subject`) and rejects requests over the limit with `429 { "error":
"rate_limited" }` plus a `Retry-After` header. Successful requests carry the
standard `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers.

Two tiers, each with its own per-window budget:

| Tier      | Endpoints                                                                                                   | Default limit |
| --------- | ----------------------------------------------------------------------------------------------------------- | ------------- |
| `ask`     | `POST /api/ask`, `POST /api/retrieve`                                                                        | 30 / window   |
| `trigger` | `POST /api/source-sync/run`, `POST /api/fix-patrol/run`, `POST /api/fix-patrol/improve/run`, `POST /api/scheduled-tasks/:key/run`, `POST /api/knowledge/repositories/index` | 5 / window    |

The limiter can only attribute a request to a caller when auth is on, so it
**no-ops when auth is disabled** (local dev) — there is no principal to key on.
The global AI cap (L2) still protects metered work in that case.

## L2 — global in-flight AI-job cap

Admission control on concurrent metered work. Before the ask service enqueues an
`answer_question` job — and crucially **before it records the question log**, so
a rejection never orphans state — it calls `assertAiCapacity`
(`apps/api/src/platform/ai-capacity.ts`). That counts the AI jobs currently in
flight (states `created | retry | active`, across every provider queue) via
`broker.countInFlight`, a single aggregate SQL count over pg-boss's job table.
At or above `AI_MAX_INFLIGHT_JOBS` it throws `429 { "error": "ai_capacity" }`
with `Retry-After`.

This is deliberately **admission control, not backpressure**: at the ceiling we
*reject* new work (the client resubmits after `Retry-After`) rather than queueing
it, because an unbounded queue would still eventually run and cost money. Jobs
that were already enqueued and then fail are unaffected — they retry under
pg-boss's existing policy (AI jobs: 3 attempts, 15s→300s backoff) and dead-letter
on exhaustion.

> Scope note: L2 is enforced at the `POST /api/ask` enqueue, the direct
> AI-job creator. The manual maintenance triggers are protected by the L1
> `trigger` tier today; extending the in-flight cap into their fan-out is a
> planned follow-up.

## Storage

Counters live in Postgres (`rate_limit_counters`, migration
`0036_rate_limit_counters.sql`) and are incremented with an atomic
`INSERT … ON CONFLICT … DO UPDATE` so the count is correct across multiple API
instances. The same statement drops the key's own expired windows, so an active
key keeps a single row; `prune()` sweeps rows left by keys that have gone silent.
An in-memory implementation (`InMemoryRateLimitStore`) backs unit tests and
auth-disabled local dev.

## Configuration

| Env var                         | Default | Meaning                                                        |
| ------------------------------- | ------- | -------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED`            | `true`  | Master switch for L1 **and** L2 (set `false` to disable both). |
| `RATE_LIMIT_WINDOW_MS`          | `60000` | Fixed-window width shared by both request tiers.               |
| `RATE_LIMIT_ASK_PER_WINDOW`     | `30`    | Ask-tier requests per principal per window.                    |
| `RATE_LIMIT_TRIGGER_PER_WINDOW` | `5`     | Trigger-tier requests per principal per window.                |
| `AI_MAX_INFLIGHT_JOBS`          | `20`    | Global ceiling on concurrent in-flight AI jobs.                |

## Observability (Grafana)

Every decision is logged as a structured event by the shared logger, so the
throttling behaviour can be visualised without any extra metrics plumbing (ship
the API logs to Loki and query by field).

**L1 event** — `event: "rate_limit"`

| Field               | Notes                                            |
| ------------------- | ------------------------------------------------ |
| `decision`          | `"allowed"` (level `debug`) or `"blocked"` (`warn`) |
| `tier`              | `"ask"` or `"trigger"`                            |
| `subject`           | the principal the limit was applied to           |
| `limit` / `count` / `remaining` | budget and usage in the current window |
| `windowMs`          | window width                                     |
| `retryAfterSeconds` | present on blocked events                        |

**L2 event** — `event: "ai_capacity"`

| Field               | Notes                                            |
| ------------------- | ------------------------------------------------ |
| `decision`          | `"allowed"` (`debug`) or `"blocked"` (`warn`)    |
| `inFlight` / `limit`| current in-flight AI jobs vs. the ceiling        |
| `retryAfterSeconds` | present on blocked events                        |

> `allowed` decisions log at `debug`, so to graph request-vs-limit volume (not
> just rejections) run the API at `LOG_LEVEL=debug`. Rejections are always
> visible at the default `info` level via the `warn` lines.

Example LogQL panels:

```logql
# Throttled requests per tier over time
sum by (tier) (
  count_over_time({service="api"} | json | event="rate_limit" | decision="blocked" [$__interval])
)

# AI capacity rejections
sum(
  count_over_time({service="api"} | json | event="ai_capacity" | decision="blocked" [$__interval])
)

# Current in-flight AI jobs (last observed value from allowed/blocked events)
max_over_time({service="api"} | json | event="ai_capacity" | unwrap inFlight [$__interval])
```
