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

Admission control on concurrent metered work, enforced **atomically** at enqueue
time (#288a). The ask service admits an `answer_question` through
`JobBroker.createIfAdmitted` (`apps/api/src/jobs/pg-boss-broker.ts`): it counts
the in-flight AI jobs and enqueues the new one **under a single cluster-wide
advisory lock** (`pg_advisory_xact_lock`, one fixed key shared by all AI
admission control), so the count and the send are one indivisible critical
section. Two concurrent `POST /api/ask` calls can therefore no longer both read
"19 in flight" and both enqueue — the losing caller counts *after* the winner's
row is committed and is shed. The lock relies on Postgres's default READ
COMMITTED isolation so the post-lock count sees every row prior admissions
committed.

The atomic gate replaces an earlier check-then-act race (`countInFlight` read,
then a separate `create()`), which under concurrency could overshoot the ceiling.
The **residual bound** is only the documented reserve headroom: because an
interactive ask may be admitted via the reserve even when the global lane is full,
interactive in-flight work can reach at most `AI_MAX_INFLIGHT_JOBS +
AI_INTERACTIVE_RESERVED_JOBS` — by design, not overshoot.

A cheap, non-atomic pre-check (`assertAiCapacity` in
`apps/api/src/platform/ai-capacity.ts`) still runs **before the question log is
recorded**, so an already-saturated system sheds load before writing any state —
a load-shedding optimization, not the authoritative gate. Both paths count AI
jobs in flight (states `created | retry | active`, across every provider queue)
via `broker.countInFlight`, aggregate SQL over pg-boss's job table, and share the
same class-aware block rule and the same `aiInflightCapacity` policy. The
questionnaire drip adopts the same primitive but enqueues its OWN job type,
`answer_question_batch`, under the **non-interactive** policy
(`nonInteractiveAiCapacity`, #288c): batch answers are metered/globally-capped
but never occupy the interactive reserve, so a bulk questionnaire cannot erode the
headroom that protects live `/api/ask`. On non-admission it reverts the item to
pending and deletes its log, then pauses (the derived-state model resumes it on
the next read/completion).

The check is **class-aware** (#240). AI job types split into an *interactive*
class — a live caller is waiting: `answer_question` (including gap-closure
verification re-asks) and `outline_flow_seed`; see `INTERACTIVE_AI_JOB_TYPES` in
`packages/jobs/src/catalog.ts` — and everything else, the maintenance fan-out
(patrol scans, drafting, gap summaries, …) plus the questionnaire batch
(`answer_question_batch`, #288c). The batch type is in `AI_JOB_TYPES` (so the
global ceiling counts it) but deliberately **absent** from
`INTERACTIVE_AI_JOB_TYPES`, so it can never satisfy the reserve condition — a
questionnaire drip therefore cannot 429 a live ask via the interactive lane. An
interactive enqueue is rejected
with `429 { "error": "ai_capacity" }` + `Retry-After` only when **both** hold:

1. in-flight interactive jobs ≥ `AI_INTERACTIVE_RESERVED_JOBS` (the reserve is
   fully occupied), **and**
2. in-flight AI jobs of any class ≥ `AI_MAX_INFLIGHT_JOBS` (the global ceiling
   is reached).

So an hourly patrol burst that fills the global ceiling can no longer push
`/api/ask` into 429: maintenance work never occupies the interactive reserve,
which always leaves at least `AI_INTERACTIVE_RESERVED_JOBS` slots claimable by
asks. Set the reserve to `0` to restore the single shared ceiling; values above
the ceiling are clamped to it.

This is deliberately **admission control, not backpressure**: at the ceiling we
*reject* new work (the client resubmits after `Retry-After`) rather than queueing
it, because an unbounded queue would still eventually run and cost money. Jobs
that were already enqueued and then fail are unaffected — they retry under
pg-boss's existing policy (AI jobs: 3 attempts, 15s→300s backoff) and dead-letter
on exhaustion.

> Scope note: the atomic L2 gate is enforced at the `POST /api/ask` enqueue, at
> the questionnaire drip's enqueue, **and at every maintenance fan-out enqueue**
> (#288b) — all through the reusable `createIfAdmitted` primitive and the one
> shared advisory lock, so interactive and maintenance admissions contend on a
> single mutually-exclusive count. Maintenance fan-out admits under the *stricter*
> non-interactive policy below; the manual triggers themselves remain protected by
> the L1 `trigger` tier.

### Maintenance fan-out is admission-controlled too (#288b)

Maintenance fan-out (the hourly patrols, the gap→PR reconciler, source-change
sync, the seed-plan draft batch) no longer enqueues AI work uncapped. Every
maintenance AI enqueue admits through the same atomic primitive, but under the
**non-interactive** policy (`nonInteractiveAiCapacity` in `ai-capacity.ts`):
strictly under the global ceiling, always leaving the interactive reserve free.
It rejects iff

    in-flight AI jobs (any class) ≥ AI_MAX_INFLIGHT_JOBS − AI_INTERACTIVE_RESERVED_JOBS

(the reserve is carved out by lowering the effective limit, so there is no
separate reserve lane — the block rule reduces to `inFlight ≥ limit`). Because
this shares the interactive gate's lock and count, maintenance already could not
429 a live ask; this makes it a **cost** bound too — maintenance never runs the
global count past `limit − reserved`. `outline_flow_seed` is interactive-class and
is deliberately left on the interactive path, so a maintenance shed never starves
a flow outline.

## Schema-invalid watcher output — repair then terminal-fail (#288d)

The retry budget above is for **transient** failures (a provider blip, a timeout).
A **schema-invalid** completion is a *deterministic* contract violation: it
reproduces on every retry, so spending the full 3-attempt budget on it burns paid
generations for nothing. `completeJob` handles it in two layers:

- **Repair-reprompt.** For a **repairable** job type (the reshape-style provider
  jobs — `answer_question`, `answer_question_batch`, `summarize_gap`,
  `detect_contradiction`, `suggest_consolidation`, `reconcile_gap_clusters`,
  `outline_flow_seed`, `revise_seed_plan`), the first schema-invalid output is routed to **one informed
  repair**: the prior output + the exact Zod contract violations are stashed in a
  repair-context store keyed by the job id, and the **same** job is re-dispatched
  (pg-boss `active→retry`, so every waiter and the question-log linkage still
  resolve under the original id). When the watcher re-claims it, its provider
  runner runs a single-shot reshape (one model call, no retrieval, no agent loop).
  the answer-contract types (`answer_question` and `answer_question_batch`)
  additionally enforce a citation-subset safety guard — a repaired output may drop
  citations but never add one the prior output didn't cite (citations are derived
  in code, never fabricated by the model).
- **Terminal-fail backstop.** Anything not eligible for repair — a non-repairable
  (source-grounded / agentic / patch-emitting) type, repair disabled by config, a
  failed safety guard, or a repair run that is *still* schema-invalid — fails
  **terminally** on the spot (`JobBroker.failTerminal`: straight to `failed` +
  dead-letter, skipping remaining retries). Net paid generations for a
  deterministic failure: the original + at most **one** informed repair, then
  terminal — never a blind 3× retry.

Each decision emits a structured `job_repair` event (`decision`:
`enqueued` | `succeeded` | `failed`). A successful completion also warns
(`"watcher output carried undeclared fields stripped to the job contract"`) when
the output carried fields the job contract doesn't declare — surfacing the silent
`z.object` strip without failing on it.

## L3 — per-tick maintenance fan-out budget (#288b)

Global admission (L2) bounds *concurrent* cost, but a single maintenance tick can
still churn: one patrol/reconciler run that fans out to hundreds of documents
would admit-then-defer in a tight loop, and pg-boss's retries would multiply the
survivors. L3 adds a **per-tick fan-out budget** layered *under* the L2 ceiling.

A `FanoutBudget` (`apps/api/src/platform/maintenance-fanout.ts`) is created once
per tick — after the run lock, so a skipped overlapping run spends nothing — and
threaded to every maintenance AI enqueue site (the patrol lenses, the reconciler's
reshape + cluster drafting, source-change sync, the seed-plan draft batch). Each
enqueue calls `budget.admit(type, input)`, which:

1. consults a **local per-tick counter** first (free — no I/O): once
   `MAINTENANCE_MAX_AI_JOBS_PER_TICK` jobs have been admitted this tick, further
   admits return `{ ok: false, reason: "budget_exhausted" }`;
2. otherwise makes the **one atomic** `createIfAdmitted` round-trip under the
   non-interactive policy; a global-ceiling rejection returns `{ ok: false, reason:
   "capacity" }`.

The budget is the single place the `class: non-interactive` rule + the budget
live — no site re-derives it. When rate limiting is disabled the admission step is
a plain `ctx.jobs.create` pass-through, so local dev keeps enqueueing while still
honouring the per-tick budget.

**Defer-and-re-enter shedding.** On any `{ ok: false }` the site *defers* that unit
of work exactly like the pre-existing `MAX_DRAFTS_PER_TICK` cap: the patrols leave
the doc unstamped (not gated → re-selected next tick), the reconciler holds the
processed revision so the next tick re-drafts the remainder, source-change sync
holds the source baseline, and the seed-plan approve batch (replay-safe) resumes on
re-approve. Maintenance is sheddable and idempotent, so a deferred tick costs
nothing and simply re-enters later. The default budget (12) is `≤ limit − reserved`
(20 − 5 = 15), so one tick can never fill the maintenance ceiling by itself.

**Retry budget.** Maintenance AI job types now retry **2×** instead of 3× (the
interactive types — `answer_question`, `outline_flow_seed` — keep 3×); the split
is a catalog constant derived from `AI_JOB_TYPES − INTERACTIVE_AI_JOB_TYPES` in
`packages/jobs/src/catalog.ts`, so a runaway patrol can't triple its metered spend
on retries.

The `*__dead_letter` queues remain the failure-runaway signal; a proactive
queue-depth alarm is a noted follow-up, not built here.

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
| `AI_INTERACTIVE_RESERVED_JOBS`  | `5`     | In-flight slots reserved for interactive AI jobs (`0` disables the reserve; clamped to the ceiling). |
| `MAINTENANCE_MAX_AI_JOBS_PER_TICK` | `12` | Max AI jobs one maintenance fan-out tick may enqueue (L3 per-tick budget, #288b). Kept ≤ `AI_MAX_INFLIGHT_JOBS − AI_INTERACTIVE_RESERVED_JOBS`. |
| `MAINTENANCE_FANOUT_ALERT_DEFERRED` | `20` | When a tick defers/rejects ≥ this many enqueues, its `maintenance_fanout` event is flagged `runaway` and escalated (#288b). |
| `MAGPIE_JOB_REPAIR_ENABLED`     | `true`  | One informed repair-reprompt for a schema-invalid repairable output before terminal-fail (#288d); `false` ⇒ immediate terminal-fail. |

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
| `interactiveInFlight` / `reserved` | interactive-class in-flight jobs vs. the reserved headroom |
| `retryAfterSeconds` | present on blocked events                        |

**L3 event** — `event: "maintenance_fanout"` (one per maintenance tick, #288b)

| Field                                    | Notes                                                             |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `decision`                               | `"ok"` (`debug`) or `"capped"` (`warn`, when any shedding occurred) |
| `taskType` / `flowId`                    | the tick's task and flow (`"default"` for the unrouted flow)      |
| `attempted` / `enqueued`                 | admits attempted vs. actually enqueued this tick                  |
| `deferredByBudget` / `rejectedByCapacity`| shed by the local per-tick budget vs. the global admission ceiling |
| `budget`                                 | the per-tick budget in force (`MAINTENANCE_MAX_AI_JOBS_PER_TICK`) |
| `runaway`                                | `true` (message escalated) once `deferredByBudget + rejectedByCapacity ≥ MAINTENANCE_FANOUT_ALERT_DEFERRED` |

The same counters are also persisted onto the tick's `MaintenanceRun.details.fanout`
for the Schedules audit.

> `allowed`/`ok` decisions log at `debug`, so to graph request-vs-limit volume (not
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
