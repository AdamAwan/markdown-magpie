# Rate limiting & AI cost controls

> **Status:** living spec (as-built). Source of truth for how Markdown Magpie throttles
> metered request traffic, caps concurrent in-flight AI work, bounds maintenance fan-out,
> and accounts for AI spend. Follows the [spec conventions](./README.md#conventions).

## Purpose

Stop a single authenticated caller — or a maintenance burst — from running up unbounded
AI spend or starving the queue, and give operators the numbers to see it happening. Four
layers stack, each independent and each env-configurable: **L1** throttles metered request
traffic per principal, **L2** caps concurrent in-flight AI jobs at enqueue time, **L3**
bounds how much a single maintenance tick can fan out, and a **cost-accounting** layer
turns watcher-reported token usage into money against an operator price table. Every
decision emits a structured log event for dashboards. All generative work stays queue-only
([ai-jobs.md](./ai-jobs.md)); these controls gate the *enqueue*, never an inline chat call.

## L1 — per-principal request rate limiting

A Hono middleware (`apps/api/src/http/rate-limit.ts`) applied to the metered endpoints.

- **RL1** — The limiter keys a **fixed-window counter** on the authenticated principal
  (`Principal.subject`) and MUST reject a request over the limit with
  `429 { "error": "rate_limited" }` plus a `Retry-After` header. Every successful response
  MUST carry the standard `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`
  headers so well-behaved clients can self-pace.
- **RL2** — When a request has **no principal** — auth disabled for local dev, or a route
  that somehow became reachable without one — the limiter MUST NOT bypass. It falls back to
  a per-client-IP key (`anon:ip:<addr>`), so an unauthenticated route is still throttled
  rather than silently unlimited (#293). The global AI cap (L2) still protects metered work
  in that case too.
- **RL3** — The client IP is the raw socket peer by default. `X-Forwarded-For` is
  client-spoofable, so the limiter MUST ignore it unless `RATE_LIMIT_TRUST_FORWARDED_FOR=true`
  is set (only behind a trusted reverse proxy); when trusted, it keys on the left-most
  `X-Forwarded-For` entry (the original client). When no IP can be resolved at all (e.g. the
  `app.request()` test harness), anonymous traffic collapses to one shared `anon:unknown`
  bucket — coarse, but still a real limit.
- **RL4** — The limiter runs in **two tiers**, each with its own per-window budget:

  | Tier      | Endpoints                                                                                                   | Default limit |
  | --------- | ----------------------------------------------------------------------------------------------------------- | ------------- |
  | `ask`     | `POST /api/ask`, `POST /api/retrieve`, `POST /api/route`                                                     | 30 / window   |
  | `trigger` | `POST /api/source-sync/run`, `POST /api/fix-patrol/run`, `POST /api/fix-patrol/improve/run`, `POST /api/scheduled-tasks/:key/run`, `POST /api/knowledge/repositories/index`, `POST /api/flows/:flowId/seed-bootstrap/run`, `POST /api/questionnaires` | 5 / window    |

  The `ask` tier covers cheap-but-metered read/answer traffic; the `trigger` tier covers the
  expensive manual maintenance triggers. Both windows share one width
  (`RATE_LIMIT_WINDOW_MS`).
- **RL5** — `RATE_LIMIT_ENABLED=false` is the master switch that disables **L1 and L2**
  together. With the switch on but auth disabled (local dev) there is no principal, so
  requests are attributed to the client IP via the RL2 fallback rather than passing
  unthrottled.

## L2 — global in-flight AI-job cap (admission control)

Admission control on concurrent metered work, enforced **atomically** at enqueue time
(#288a). Policy (`aiInflightCapacity` / `nonInteractiveAiCapacity`) and action
(`assertAiCapacity` / `aiCapacityError`) live in `apps/api/src/platform/ai-capacity.ts`;
the atomic enqueue lives in `JobBroker.createIfAdmitted`.

- **RL6** — The ask service MUST admit an `answer_question` through
  `JobBroker.createIfAdmitted`: it counts the in-flight AI jobs and enqueues the new one
  **under a single cluster-wide advisory lock** (`pg_advisory_xact_lock`, one fixed key
  shared by all AI admission control), so the count and the send are one indivisible
  critical section. Two concurrent `POST /api/ask` calls can therefore no longer both read
  "19 in flight" and both enqueue — the losing caller counts *after* the winner's row is
  committed and is shed. The lock relies on Postgres's default READ COMMITTED isolation so
  the post-lock count sees every row prior admissions committed.
- **RL7** — A cheap, non-atomic **pre-check** (`assertAiCapacity`) SHOULD run **before the
  question log is recorded**, so an already-saturated system sheds load before writing any
  state. It is a load-shedding optimization evaluating the same block rule at the same
  threshold — **not** the authoritative gate. The authoritative, race-free gate is
  `createIfAdmitted` at enqueue time.
- **RL8** — Both paths count AI jobs in flight (states `created | retry | active`, across
  every provider queue) via `broker.countInFlight`, aggregate SQL over pg-boss's job table,
  and MUST share the same class-aware block rule and the same `aiCapacityBounds`
  limit/reserve computation so the two classes can never drift apart.
- **RL9** — The gate is **class-aware** (#240). AI job types split into an *interactive*
  class — a live caller is waiting: `answer_question` (including gap-closure verification
  re-asks) and `outline_flow_seed`; see `INTERACTIVE_AI_JOB_TYPES` in
  `packages/jobs/src/catalog.ts` — and everything else: the maintenance fan-out (patrol
  scans, drafting, gap summaries, …) plus the questionnaire batch
  (`answer_question_batch`). The batch type is in `AI_JOB_TYPES` (so the global ceiling
  counts it) but deliberately **absent** from `INTERACTIVE_AI_JOB_TYPES`, so it can never
  satisfy the reserve condition.
- **RL10** — An **interactive** enqueue is rejected with `429 { "error": "ai_capacity" }` +
  `Retry-After` **only when both** hold:

  1. in-flight interactive jobs ≥ `AI_INTERACTIVE_RESERVED_JOBS` (the reserve is fully
     occupied), **and**
  2. in-flight AI jobs of any class ≥ `AI_MAX_INFLIGHT_JOBS` (the global ceiling is reached).

  So an hourly patrol burst that fills the global ceiling can no longer push `/api/ask` into
  429: maintenance work never occupies the interactive reserve, which always leaves at least
  `AI_INTERACTIVE_RESERVED_JOBS` slots claimable by asks. Setting the reserve to `0` restores
  a single shared ceiling; a reserve above the ceiling is clamped to the ceiling.
- **RL11** — The **residual bound**: because an interactive ask may be admitted via the
  reserve even when the global lane is full, interactive in-flight work may reach at most
  `AI_MAX_INFLIGHT_JOBS + AI_INTERACTIVE_RESERVED_JOBS` — by design, not overshoot.
- **RL12** — The questionnaire drip adopts the same primitive but enqueues its OWN job type,
  `answer_question_batch`, under the **non-interactive** policy (`nonInteractiveAiCapacity`,
  #288c): batch answers are metered/globally-capped but MUST NOT occupy the interactive
  reserve, so a bulk questionnaire cannot erode the headroom that protects live `/api/ask`.
  On non-admission the drip reverts the item to pending and deletes its log, then pauses (the
  derived-state model resumes it on the next read/completion).
- **RL13** — Admission is enforced at the `POST /api/ask` enqueue, at the questionnaire
  drip's enqueue, **and at every maintenance fan-out enqueue** (#288b) — all through the
  reusable `createIfAdmitted` primitive and the one shared advisory lock, so interactive and
  maintenance admissions contend on a single mutually-exclusive count. When
  `RATE_LIMIT_ENABLED=false`, the capacity policy is `undefined` (a pass-through) and the
  enqueue is uncapped.
- **RL14** — This is deliberately **admission control, not backpressure**: at the ceiling
  new work is *rejected* (the client resubmits after `Retry-After`) rather than queued,
  because an unbounded queue would still eventually run and cost money. Jobs already enqueued
  that then fail are unaffected — they retry under pg-boss's policy (RL20) and dead-letter on
  exhaustion.

### Maintenance fan-out is admission-controlled too (#288b)

- **RL15** — Maintenance fan-out (the hourly patrols, the gap→PR reconciler, source-change
  sync, the seed-plan draft batch) MUST NOT enqueue AI work uncapped. Every maintenance AI
  enqueue admits through the same atomic primitive, under the **non-interactive** policy
  (`nonInteractiveAiCapacity`): strictly under the global ceiling, always leaving the
  interactive reserve free. It rejects iff

      in-flight AI jobs (any class) ≥ AI_MAX_INFLIGHT_JOBS − AI_INTERACTIVE_RESERVED_JOBS

  The reserve is carved out by lowering the effective limit — there is no separate reserve
  lane, so the block rule reduces to `inFlight ≥ limit`. Because this shares the interactive
  gate's lock and count, maintenance already could not 429 a live ask; this makes it a
  **cost** bound too — maintenance never runs the global count past `limit − reserved`.
  `outline_flow_seed` is interactive-class and is deliberately left on the interactive path,
  so a maintenance shed never starves a flow outline.

## Schema-invalid watcher output — repair then terminal-fail (#288d)

The retry budget (RL20) is for **transient** failures (a provider blip, a timeout). A
**schema-invalid** completion is a *deterministic* contract violation: it reproduces on
every retry, so spending the full budget on it burns paid generations for nothing.
`completeJob` handles it in two layers.

- **RL16** — **Repair-reprompt.** For a **repairable** job type (`answer_question`,
  `answer_question_batch`, `summarize_gap`, `detect_contradiction`, `suggest_consolidation`,
  `reconcile_gap_clusters`, `outline_flow_seed`, `revise_seed_plan`; see
  `REPAIRABLE_JOB_TYPES` in `packages/jobs/src/catalog.ts`), the first schema-invalid output
  MUST be routed to **one informed repair**: the prior output + the exact Zod contract
  violations are stashed in a repair-context store keyed by the job id, and the **same** job
  is re-dispatched (pg-boss `active→retry`, so every waiter and the question-log linkage
  still resolve under the original id). When the watcher re-claims it, its provider runner
  runs a single-shot reshape (one model call, no retrieval, no agent loop).
- **RL17** — The answer-contract types (`answer_question` and `answer_question_batch`)
  additionally enforce a **citation-subset safety guard**: a repaired output MAY drop
  citations but MUST NOT add one the prior output didn't cite (citations are derived in code,
  never fabricated by the model).
- **RL18** — **Terminal-fail backstop.** Anything not eligible for repair — a non-repairable
  (source-grounded / agentic / patch-emitting) type, repair disabled by config
  (`MAGPIE_JOB_REPAIR_ENABLED=false`), a failed safety guard, or a repair run that is *still*
  schema-invalid — MUST fail **terminally** on the spot (`JobBroker.failTerminal`: straight
  to `failed` + dead-letter, skipping remaining retries). Net paid generations for a
  deterministic failure: the original + at most **one** informed repair, then terminal —
  never a blind 3× retry.
- **RL19** — Each decision emits a structured `job_repair` event (`decision`:
  `enqueued` | `succeeded` | `failed`). A successful completion also warns
  (`"watcher output carried undeclared fields stripped to the job contract"`) when the output
  carried fields the job contract doesn't declare — surfacing the silent `z.object` strip
  without failing on it.

## L3 — per-tick maintenance fan-out budget (#288b)

Global admission (L2) bounds *concurrent* cost, but a single maintenance tick can still
churn: one run that fans out to hundreds of documents would admit-then-defer in a tight loop,
and pg-boss's retries would multiply the survivors. L3 adds a **per-tick fan-out budget**
layered *under* the L2 ceiling, in `apps/api/src/platform/maintenance-fanout.ts`.

- **RL20** — **Retry budget.** Enqueued AI jobs retry with backoff (`retryDelay = 15s` →
  `retryDelayMax = 300s` for provider work; `30s` → `600s` otherwise) and dead-letter on
  exhaustion. Maintenance AI job types retry **2×**; the interactive types (`answer_question`,
  `outline_flow_seed`) keep **3×**. The split is a catalog constant derived from
  `AI_JOB_TYPES − INTERACTIVE_AI_JOB_TYPES` in `packages/jobs/src/catalog.ts`, so a runaway
  patrol can't triple its metered spend on retries.
- **RL21** — A `FanoutBudget` (`createFanoutBudget`) MUST be created once per tick — after
  the run lock, so a skipped overlapping run spends nothing — and threaded to every
  maintenance AI enqueue site (the patrol lenses, the reconciler's reshape + cluster
  drafting, source-change sync, the seed-plan draft batch). It is the **single** place the
  `class: non-interactive` rule + the budget live; no enqueue site re-derives them.
- **RL22** — Each enqueue calls `budget.admit(type, input)`, which:

  1. consults a **local per-tick counter** first (free — no I/O): once
     `MAINTENANCE_MAX_AI_JOBS_PER_TICK` jobs have been admitted this tick, further admits
     return `{ ok: false, reason: "budget_exhausted" }`;
  2. otherwise makes the **one atomic** `createIfAdmitted` round-trip under the
     non-interactive policy; a global-ceiling rejection returns
     `{ ok: false, reason: "capacity" }`.

  When rate limiting is disabled the admission step is a plain `ctx.jobs.create`
  pass-through, so local dev keeps enqueueing while still honouring the per-tick budget.
- **RL23** — **Defer-and-re-enter shedding.** On any `{ ok: false }` the site MUST *defer*
  that unit of work exactly like the pre-existing `MAX_DRAFTS_PER_TICK` cap: the patrols
  leave the doc unstamped (not gated → re-selected next tick), the reconciler holds the
  processed revision so the next tick re-drafts the remainder, source-change sync holds the
  source baseline, and the seed-plan approve batch (replay-safe) resumes on re-approve.
  Maintenance is sheddable and idempotent, so a deferred tick costs nothing and simply
  re-enters later.
- **RL24** — The default budget (`12`) MUST stay `≤ AI_MAX_INFLIGHT_JOBS −
  AI_INTERACTIVE_RESERVED_JOBS` (20 − 5 = 15), so one tick can never fill the maintenance
  ceiling by itself. When a tick defers/rejects ≥ `MAINTENANCE_FANOUT_ALERT_DEFERRED` enqueues,
  its `maintenance_fanout` event is flagged `runaway` and escalated. The `*__dead_letter`
  queues remain the failure-runaway signal; a proactive queue-depth alarm is a noted
  follow-up, not built here.

## AI cost accounting (`AI_PRICING`)

Cost reporting is priced from **config, not code**: an `openai-compatible` endpoint can be
OpenAI, OpenRouter, Azure, or a free local vLLM, so no hardcoded rate table could be right.
Lives in `apps/api/src/platform/ai-pricing.ts`.

- **RL25** — `AI_PRICING` is an operator-supplied JSON array; each entry prices one
  `(provider, model)` pair with `inputPerMTok` / `outputPerMTok` rates **per million tokens**
  in the deployment's billing currency. The entry schema is **strict** (`z.strictObject`) so a
  typo'd field fails loudly rather than silently pricing a direction at nothing.
- **RL26** — Cost MUST be computed at read/aggregation time from stored token counts × the
  current table, and MUST NOT be stamped on the job — so correcting a mispriced entry
  retroactively re-values history. `estimateTokenCost` divides the token×rate sum by `1e6` and
  returns `undefined` when no entry matches. A `null` model (a CLI provider on its own
  default, or a pre-#268 row that reported no identity) can never match — cost stays
  **unknown** rather than being misattributed to another model's rate.
- **RL27** — Unlike the safety-neutral tuning knobs, pricing does **not** silently fall back
  on bad input: a malformed or duplicate-keyed table would produce wrong monetary numbers, so
  `parseAiPricing` returns every problem as an error and `loadConfig` **fails boot** on it. An
  unset/blank `AI_PRICING` simply means "no pricing configured" — cost reporting stays off
  until an operator opts in. (Read consumers: the Insights usage/flow rollups and
  per-schedule attribution — see [insights-charts.md](./insights-charts.md).)

## Storage

- **RL28** — L1 counters live in Postgres (`rate_limit_counters`, migration
  `0036_rate_limit_counters.sql`) and MUST be incremented with an atomic
  `INSERT … ON CONFLICT … DO UPDATE` so the count is correct across multiple API instances.
  The same statement drops the key's own expired windows, so an active key keeps a single
  row; `prune()` sweeps rows left by keys that have gone silent. An in-memory implementation
  (`InMemoryRateLimitStore`) backs unit tests and auth-disabled local dev. Windows are
  wall-clock slices anchored at the epoch (`windowStartFor`), so every API instance derives
  the same boundaries without coordination.

## Configuration

| Env var                         | Default | Meaning                                                        |
| ------------------------------- | ------- | -------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED`            | `true`  | Master switch for L1 **and** L2 (set `false` to disable both). |
| `RATE_LIMIT_WINDOW_MS`          | `60000` | Fixed-window width shared by both request tiers.               |
| `RATE_LIMIT_ASK_PER_WINDOW`     | `30`    | Ask-tier requests per principal per window.                    |
| `RATE_LIMIT_TRIGGER_PER_WINDOW` | `5`     | Trigger-tier requests per principal per window.                |
| `RATE_LIMIT_TRUST_FORWARDED_FOR` | `false` | When a request has no principal, key the fallback on the left-most `X-Forwarded-For` entry instead of the raw socket peer. Enable **only** behind a trusted reverse proxy (the header is client-spoofable). |
| `AI_MAX_INFLIGHT_JOBS`          | `20`    | Global ceiling on concurrent in-flight AI jobs.                |
| `AI_INTERACTIVE_RESERVED_JOBS`  | `5`     | In-flight slots reserved for interactive AI jobs (`0` disables the reserve; clamped to the ceiling). |
| `MAINTENANCE_MAX_AI_JOBS_PER_TICK` | `12` | Max AI jobs one maintenance fan-out tick may enqueue (L3 per-tick budget, #288b). Kept ≤ `AI_MAX_INFLIGHT_JOBS − AI_INTERACTIVE_RESERVED_JOBS`. |
| `MAINTENANCE_FANOUT_ALERT_DEFERRED` | `20` | When a tick defers/rejects ≥ this many enqueues, its `maintenance_fanout` event is flagged `runaway` and escalated (#288b). |
| `MAGPIE_JOB_REPAIR_ENABLED`     | `true`  | One informed repair-reprompt for a schema-invalid repairable output before terminal-fail (#288d); `false` ⇒ immediate terminal-fail. |
| `AI_PRICING`                    | *(unset)* | JSON array of `(provider, model, inputPerMTok, outputPerMTok)` entries for cost accounting; malformed/duplicate content **fails boot** (RL27). Unset ⇒ cost reporting off. |

## Observability (Grafana)

Every decision is logged as a structured event by the shared logger, so the throttling
behaviour can be visualised without extra metrics plumbing (ship the API logs to Loki and
query by field).

**L1 event** — `event: "rate_limit"`

| Field               | Notes                                            |
| ------------------- | ------------------------------------------------ |
| `decision`          | `"allowed"` (level `debug`) or `"blocked"` (`warn`) |
| `tier`              | `"ask"` or `"trigger"`                            |
| `subject`           | the bucket the limit was applied to — a principal subject, or an anonymous fallback key (`anon:ip:<addr>` / `anon:unknown`) |
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

The same counters are also persisted onto the tick's `MaintenanceRun.details.fanout` for the
Schedules audit. A schema-invalid completion additionally emits a `job_repair` event (RL19).

> `allowed`/`ok` decisions log at `debug`, so to graph request-vs-limit volume (not just
> rejections) run the API at `LOG_LEVEL=debug`. Rejections are always visible at the default
> `info` level via the `warn` lines.

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

## Code map

| Concern | Code |
| --- | --- |
| L1 middleware, tiers, anon fallback (RL1–RL5) | `apps/api/src/http/rate-limit.ts` |
| L1 tier application on routes | `apps/api/src/features/{ask,retrieve,route,source-sync,patrol,knowledge,scheduled-tasks,seed,questionnaires}/routes.ts` |
| L2 capacity policy + pre-check + error (RL6–RL15) | `apps/api/src/platform/ai-capacity.ts` |
| Atomic admission primitive (advisory lock) | `apps/api/src/jobs/pg-boss-broker.ts` (`createIfAdmitted`, `countInFlight`, `failTerminal`), `apps/api/src/jobs/broker.ts` |
| Class sets, repairable set, retry-limit split (RL9, RL16, RL20) | `packages/jobs/src/catalog.ts` (`AI_JOB_TYPES`, `INTERACTIVE_AI_JOB_TYPES`, `REPAIRABLE_JOB_TYPES`) |
| Schema-invalid repair / terminal-fail (RL16–RL19) | `apps/api/src/jobs/*` (`completeJob`), `apps/api/src/stores/{job-repair-context-store,postgres-job-repair-context-store}.ts` |
| L3 per-tick fan-out budget (RL21–RL24) | `apps/api/src/platform/maintenance-fanout.ts` |
| AI cost accounting (RL25–RL27) | `apps/api/src/platform/ai-pricing.ts` |
| Config defaults & AI_PRICING boot validation | `apps/api/src/platform/config.ts` |
| L1 counter store (RL28) | `apps/api/src/stores/rate-limit-store.ts` (in-memory + window math), `apps/api/src/stores/postgres-rate-limit-store.ts`, migration `packages/db/migrations/0036_rate_limit_counters.sql` |

## Tests (behavioural contract)

`apps/api/src/http/rate-limit.test.ts`,
`apps/api/src/platform/{ai-capacity,ai-pricing,maintenance-fanout,config}.test.ts`,
`apps/api/src/stores/{rate-limit-store,postgres-rate-limit-store,job-repair-context-store}.test.ts`,
`packages/jobs/src/catalog.test.ts`.

## Provenance (design history)

No standalone rate-limiting design doc exists; the design history for this subsystem lives
in the inline issue/PR references above — the atomic gate and its sub-items (#288a
enqueue-atomicity, #288b maintenance fan-out + L3 budget, #288c questionnaire batch class,
#288d schema-invalid repair), the class-aware reserve (#240), and the anonymous-fallback fix
(#293). Adjacent design docs that touch this subsystem:
`docs/superpowers/specs/2026-07-16-questionnaire-mode-design.md` (the drip governor / batch
non-interactive capacity, #288c) and
`docs/superpowers/specs/2026-07-15-ai-cost-chart-redesign-design.md` (the `AI_PRICING`
read-time cost model consumed by Insights — see [insights-charts.md](./insights-charts.md)).
