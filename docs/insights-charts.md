# Insights & Charts

> **Status:** living spec (as-built). Source of truth for the web console's **Insights**
> page — the charts that visualise the health and progress of Magpie's
> knowledge-maintenance pipeline, the API aggregation endpoints behind them, and the data
> source for each. Follows the [spec conventions](./README.md#conventions).

## Purpose

Magpie is a **pipeline**, not a metrics dashboard:

```
question → gap → cluster → proposal → PR → merged → verified-closed
```

…driven by an async job queue (`ai_jobs` / pg-boss) with scheduled patrols on a cadence.
The rest of the console is table- and list-oriented (Jobs, Gaps, Proposals, Activity,
Reconciliations); none of it shows *trends over time*, *funnel conversion*,
*distributions*, or *success rates* — exactly the questions an operator most wants
answered. The Insights page fills that gap. The highest-value visuals are **flow/funnel**
and **health-over-time**, not vanity KPIs: every chart answers a concrete operator
question ("is the backlog growing?", "are merged proposals actually closing the gap?",
"what's this costing?", "what's breaking?").

## Platform & execution model

- **IC1** — Insights is a **single dedicated route**, `apps/web/src/app/insights/page.tsx`
  (`"use client"`), leaving existing pages unchanged. It fetches its own aggregates
  **page-locally on mount** through the `useInsights` hooks (→ the shared `apiGet<T>`
  client in `apps/web/src/lib/api.ts`) with a **manual refresh** button — deliberately
  **not** through `ConsoleProvider`, so the heavier, slower-moving aggregates stay off the
  console's fast (~4s) global poll. There is **no** background polling of Insights in v1.
- **IC2** — Aggregation is server-side. Each chart is backed by one endpoint under
  `apps/api/src/features/insights/` (`insightsRoutes(ctx)`, registered in
  `apps/api/src/app.ts` as `api.route("/insights", …)`). The SQL rollups live in a store,
  `apps/api/src/stores/postgres-insights-store.ts` (parametrised SQL, `date_trunc`
  time-binning, `::` casts), fronted by the `insights-store.ts` interface; `service.ts`
  resolves query params into a concrete range and delegates. Response types are declared
  once in `@magpie/core` (`packages/core/src/index.ts`) — mirrored web-side in
  `apps/web/src/lib/types.ts` — and every endpoint returns a **named-key envelope**
  (`{ series }`, `{ nodes, links }`, `{ totals, series }`, `{ usage }`, …), never a bare
  array.
- **IC3** — Every Insights endpoint is a read endpoint guarded with
  `requireScopes("read:knowledge")`, matching sibling read routes. An invalid query throws
  `400 invalid_insights_query`.
- **IC4** — **Shared query conventions.** Time-series endpoints accept
  `?from=<ISO>&to=<ISO>&bucket=day|week|month`; the window defaults to the **last 30 days**
  and `to` to now. Endpoints over a flow-carrying entity accept an optional `?flow=<flowId>`.
  All returned timestamps are ISO strings and all counts integers, and **empty buckets are
  zero-filled server-side** so the client renders continuous series. The **v1 UI uses a
  fixed "last 30 days" window** with no range picker (the params exist on the API for
  later); performance is on-demand SQL, to be optimised (caching / materialised views) only
  if needed.
- **IC5** — Quantitative charts use **Recharts** (React-19 / Next-16 friendly, SVG,
  Emotion-themeable) — chosen over pulling in the MUI ecosystem just for charts. Chart
  components live in `apps/web/src/components/insights/` (one `*Chart.tsx` per chart, plus
  the shared `ChartCard`, `CostBarChart`, `format.ts`, and `useInsights.ts`).
  > ⚠️ Two original design decisions are superseded by the as-built code — kept here so the
  > drift is explicit: (a) the original spec placed chart components under
  > `apps/web/src/components/charts/`; they actually live under `components/insights/`.
  > (b) the question-journey diagram was originally specced as **React Flow (`@xyflow/react`)
  > + dagre**; it is now a **Recharts `<Sankey>`** (see IC6). A stale
  > `import "@xyflow/react/dist/style.css"` remains at the top of `page.tsx` — harmless dead
  > import, safe to remove.

## The charts

Each chart is independently shippable: one endpoint + one component + tests. The table is
the per-chart reference; the numbered clauses below carry the non-obvious behavioural rules.

| # | Chart (component) | Operator question | Type | Endpoint | Source data |
| --- | --- | --- | --- | --- | --- |
| C1 | Question journey (`QuestionJourneyChart`) | What path does a question take, and where does volume leak? | Recharts **Sankey** | `GET /insights/journey?from&to&flow` → `{ nodes, links }` | `questions`, `question_gaps`, `gap_cluster_memberships`, `proposals` |
| C2 | Job throughput & health (`JobThroughputChart`) | Is the queue keeping up? Is a runner failing? | Recharts stacked area | `GET /insights/jobs/throughput?from&to&bucket&type` → `{ series }` | pg-boss `job` bucketed by time, stacked by state |
| C3 | Open-gap backlog (`GapBacklogChart`) | Is knowledge debt growing or shrinking? | Recharts line/area | `GET /insights/gaps/backlog?from&to&bucket&flow` → `{ series }` | `question_gaps` (+ `questions` for flow/park) |
| C4 | Answer latency (`LatencyHistogramChart`) | How long do answers take, end to end? | Recharts bar (histogram) | `GET /insights/answers/latency?from&to` → `{ bins }` | pg-boss `job` — completed `answer_question` durations |
| C5 | Verification success (`VerificationSuccessChart`) | Do merged proposals actually close the gap? | Recharts **donut** (+ trend series) | `GET /insights/verification/success?from&to&bucket` → `{ totals, series }` | `gap_closure_verification` |
| C6 | Job error breakdown (`JobErrorBreakdownChart`) | What's breaking, and in which job type? | Recharts bar | `GET /insights/jobs/errors?from&to` → `{ byCategory, byType }` | pg-boss `job` (failed rows, error metadata) |
| C7 | Knowledge-base freshness (`FreshnessChart`) | How much of the KB is overdue for review? | Recharts bar | `GET /insights/freshness` → `{ documents, sources }` | `documents`, `source_sync_state` |
| C8 | Maintenance patrol impact (`PatrolImpactChart`) | Are the patrols finding and fixing things? | Recharts bar | `GET /insights/patrols?from&to` → `{ runs }` | `maintenance_runs` (`task_type`, `details` JSONB, timestamps) |
| ~~C9~~ | Worker utilisation | Are workers saturated or idle? | *(dropped)* | *(not built)* | *(no durable heartbeat samples — see IC14)* |
| C10 | Answer feedback (`FeedbackChart`) | Are users rejecting answers — especially confident ones? | Recharts stacked area + rate line | `GET /insights/feedback?from&to&bucket&flow` → `{ totals, series }` | `questions` (`feedback`, `feedback_at`, `confidence`, `purpose`) |
| C11 | AI token usage & cost (`AiUsageChart` / `CostBarChart`) | What is each job type costing per provider/model? | Recharts horizontal cost bars | `GET /insights/ai-usage?from&to` → `{ usage }` | pg-boss `job` — completed AI-queue rows, watcher-reported usage |
| — | AI cost by flow (`AiCostByFlowChart` / `CostBarChart`) | Which flow is my AI spend going to? | Recharts horizontal cost bars | `GET /insights/ai-cost/by-flow?from&to&flow` → `{ flows }` | same rollup as C11, grouped by input `flowId` |
| — | Per-schedule cost (Schedules page column) | What is each scheduled task costing? | `/schedules` table column | `GET /insights/ai-cost/by-schedule?from&to` → `{ schedules }` | same rollup as C11, per task's `aiJobTypes` × flow |

### Behavioural rules

- **IC6 — Question journey (C1).** The Sankey renders the `{ nodes, links }` graph across
  four segments: **answer** (questions split by `confidence`, then no-gap vs gap-raised) →
  **gap** (dismissed / parked / open / clustered) → **proposal** (in-progress / rejected /
  superseded / merged) → **verify** (verified-closed / reopened / needs-attention /
  awaiting). Link widths are real counts, and the **unit of flow shifts** question → gap →
  proposal across the graph (labelled on the chart). Each unit shift MUST be carried on the
  *link* at a segment boundary, not inside a node: the `clustered → proposals` link carries
  the gap-side count (clustered gaps handed off), so the "Clustered" node stays internally
  conserved (a Sankey node is sized by `max(in, out)`) rather than ballooning to the
  proposal total. The shift to `prop_total` surfaces at "Proposals drafted", where the
  outgoing status arms sum. Proposals are windowed independently on their own `created_at`,
  so that total is **not** conserved against clustered gaps — by design. This replaces the
  earlier linear gap-to-merge funnel: a strict superset that also shows disposition, not
  just drop-off.
- **IC7 — Job throughput (C2).** pg-boss `job` rows bucketed by time and stacked by state
  (completed / failed / active / retry). The optional `?type=` filter resolves a
  `@magpie/jobs` job type to the pg-boss **queue names** its work lands in (via
  `queueDefinitionsForType`, including dead-letter queues); an **unknown** type resolves to
  an empty queue list, which the store treats as "match nothing" — an explicit empty series
  rather than a silently-ignored filter.
- **IC8 — Open-gap backlog (C3).** Gap lifecycle transitions per bucket (open / resolved /
  parked / dismissed) from `question_gaps` timestamps (`created_at`, `resolved_at`,
  `dismissed_at`, `parked_at`), with a running net-open total; joined to `questions` for
  the flow filter.
- **IC9 — Answer latency (C4).** As-built, C4 is the **end-to-end answer-job latency
  histogram**: it bins the duration (`completed_on − created_on`) of **completed
  `answer_question` pg-boss jobs** over the window into fixed `LATENCY_BINS`, zero-filling
  empty bins. The endpoint is `GET /insights/answers/latency`.
  > ⚠️ The original C4 design was a **gap-resolution** latency histogram (days from gap
  > `created_at` → proposal `merged_at`) at `GET /insights/gaps/latency`. The shipped chart
  > measures answer-job latency instead and lives at `/answers/latency`. This clause
  > documents the as-built behaviour; the original framing is retired.
- **IC10 — Verification success (C5).** `gap_closure_verification` rows split by verdict —
  `closed` (the merged doc now answers the re-asked question) vs `still_open`. The endpoint
  returns both the **overall totals** across the window and a **per-bucket `series`** for a
  trend; the shipped component renders the totals as a **donut** (Recharts `Pie` with an
  inner radius). Endpoint is `GET /insights/verification/success` (not `/insights/verification`).
- **IC11 — Job error breakdown (C6).** Failed pg-boss `job` rows over the window, split
  `byCategory` (provider / validation / timeout / external / internal) and `byType` (job
  type). Window-only — no time axis, so no `bucket`.
- **IC12 — KB freshness (C7).** A **point-in-time snapshot** taking no params: active
  `documents` bucketed by review-cycle compliance (fresh / due / overdue via
  `last_verified` + `review_cycle_days`) and `source_sync_state` sources bucketed by
  last-sync recency.
- **IC13 — Patrol impact (C8).** Per-`task_type` run / finding / proposal counts from
  `maintenance_runs` (`details` JSONB) over the window. Window-only — grouped by task type,
  not time.
- **IC14 — Worker utilisation (C9) is DROPPED and MUST NOT be fabricated.** A
  busy-ratio-over-time chart needs a durable time-series of heartbeat samples. The only
  heartbeat store is `watcher_registrations` (migration `0025_watcher_registry.sql`), which
  the API **upserts** one row per watcher on every claim/heartbeat and prunes on read — it
  holds each watcher's *latest* `last_seen_at` / `current_job_id`, not a sample history. A
  new sampling table was explicitly ruled out for this work, so no endpoint, store method,
  or component was built and no data was invented.
- **IC15 — Answer feedback (C10, #241).** Live questions' helpful / unhelpful verdicts per
  bucket, **windowed on `feedback_at`**, with the `unhelpful` stack split into
  **confident-answer rejections** (`confidence` high/medium — the subset that also raises a
  `feedback` gap, see [question-logging.md](./question-logging.md)) vs the rest, plus an
  unhelpful-**rate** line. Verification re-asks are **excluded** (filtered on `purpose`).
- **IC16 — AI token usage & cost (C11, #241).** One **horizontal bar per priced
  `(job type, provider, model)` triple**, length = the triple's spend, with **input-cost
  and output-cost stacked** (both money, so total length = total cost), heaviest first.
  **Cost is on the axis; tokens ride the tooltip** (input / output / total) alongside
  `jobsWithUsage` / `jobs`. The three cost states stay **distinct so nothing reads as `$0`**:
  **priced** (matched `AI_PRICING` entry → a bar), **unpriced** (usage reported but no price
  entry → excluded from bars, named in a footnote), **unmetered** (CLI providers report no
  usage → footnoted count). When nothing is priced, the plot is replaced by an empty-state
  CTA naming the unpriced pairs. `estimatedCost` is the `{ input, output, total }` split
  (`AiCostEstimate`), **priced at read time** (tokens × per-MTok `AI_PRICING` rate, via
  `summariseAiCost` + `apps/api/src/platform/ai-pricing.ts`, resolved from
  `ctx.settings.aiPricing`) and present only for a matched `(provider, model)`. **Cost is
  never persisted** — always `stored tokens × current AI_PRICING`. The watcher sums each
  run's provider-reported usage and stamps its execution identity; the API persists both on
  the `{ result, executor, usage?, provider?, model? }` completion envelope. **No new
  table**: the pg-boss retention window (30 days) covers the chart's window, and the queue-
  name → `(type, provider)` mapping is derived from the `@magpie/jobs` catalog.
  > This supersedes the original C11 design, where the bars encoded **tokens** and cost
  > "rode text — never a series colour or a second y-axis". For a cost card, cost belongs on
  > the axis; see the 2026-07-15 redesign in Provenance.
- **IC17 — AI cost by flow.** The same rollup grouped by `data->'input'->>'flowId'` (the
  pg-boss `JobEnvelope`), aggregated to one cost summary per flow, drawn with the **shared
  `CostBarChart`** and the same three-state honesty as IC16 (unpriced flows footnoted,
  empty-state CTA when none priced). Jobs whose input carries **no `flowId`**
  (`answer_question`, cross-flow `fold_*`) group as **Unattributed**. Flow display names are
  resolved **by the console** from `ctx.knowledgeConfig.flows`, not the API. `?flow=`
  narrows to a single flow. Ordered by cost then tokens, heaviest first.
- **IC18 — Per-schedule cost.** A **"Cost (30d)" column on the `/schedules` page**
  (`SchedulesPanel`) — *not* the Insights page — showing each task's approximate spend
  (`estimatedCost.total`). It reuses the per-flow rollup, summing the AI job types the task's
  orchestrator fans out to (`aiJobTypes` in the task registry) filtered to the task's own
  flow (so no extra query); tasks that spend no model tokens (e.g. the GitHub snapshot
  refresh) are omitted. The envelope is **keyed by `ScheduledTask.key`** so the console
  joins it onto the schedules table, and is fetched page-locally so it stays off the
  console's fast poll.

## Code map

| Concern | Code |
| --- | --- |
| Insights page shell + page-local fetch | `apps/web/src/app/insights/page.tsx`, `apps/web/src/components/insights/useInsights.ts`, `apps/web/src/lib/api.ts` |
| Chart components | `apps/web/src/components/insights/*Chart.tsx`, plus `ChartCard.tsx`, `CostBarChart.tsx`, `format.ts` |
| Per-schedule cost column | `apps/web/src/components/SchedulesPanel.tsx`, `apps/web/src/app/schedules/page.tsx` |
| API routes + param schemas | `apps/api/src/features/insights/{routes,schema}.ts`, registered in `apps/api/src/app.ts` |
| Service (range resolution, delegation) | `apps/api/src/features/insights/service.ts` |
| Cost pricing (pure, DB-free) | `apps/api/src/features/insights/cost.ts` (`summariseAiCost`), `apps/api/src/platform/ai-pricing.ts`, `AI_PRICING` in `apps/api/src/platform/config.ts` |
| SQL rollups (store) | `apps/api/src/stores/postgres-insights-store.ts`, interface `apps/api/src/stores/insights-store.ts` |
| Response/DTO types | `@magpie/core` (`packages/core/src/index.ts`); web mirror `apps/web/src/lib/types.ts` |
| Job-type → queue-name mapping | `apps/api/src/jobs/pg-boss-broker.ts` (`queueDefinitionsForType`), `@magpie/jobs` catalog |
| Scheduled-task fan-out (`aiJobTypes`) | `apps/api/src/scheduling/task-registry.ts` (`listScheduledTasks`) |

## Tests (behavioural contract)

- **API:** `apps/api/src/features/insights/routes.test.ts` (Hono app — envelope shape and
  param validation), `apps/api/src/features/insights/cost.test.ts` (the pure `summariseAiCost`
  reduction and three-state cost accounting), and
  `apps/api/src/stores/postgres-insights-store.integration.test.ts` (the SQL rollups against
  seeded data, gated by `RUN_PG_INTEGRATION=1`).
- **Web:** one colocated `node:test` `.test.tsx` per chart under
  `apps/web/src/components/insights/` — `AiCostByFlowChart`, `AiUsageChart`, `CostBarChart`,
  `FeedbackChart`, `FreshnessChart`, `GapBacklogChart`, `JobErrorBreakdownChart`,
  `JobThroughputChart`, `LatencyHistogramChart`, `PatrolImpactChart`,
  `QuestionJourneyChart`, `VerificationSuccessChart` — each rendering the component with
  fixture data and asserting it renders and shows the expected labels / empty-states.
  Per-schedule cost is covered by `apps/web/src/components/SchedulesPanel.test.tsx`.

## Provenance (design history)

Consolidates, and supersedes as a behavioural description:

- `docs/superpowers/specs/2026-07-06-question-journey-sankey-design.md` — the branching
  question-journey Sankey (C1/IC6), which replaced the original linear React-Flow funnel.
- `docs/superpowers/specs/2026-07-15-ai-cost-chart-redesign-design.md` — the AI-cost card
  redesign (IC16/IC17): cost on the axis with input/output stacked, tokens in the tooltip,
  and the priced / unpriced / unmetered three-state honesty; supersedes the original
  tokens-on-bars framing.
- `docs/superpowers/specs/2026-06-13-manual-knowledge-gap-feedback-design.md` — the
  `feedback` gap source that the answer-feedback chart's confident-rejection subset keys off
  (IC15).

This file was itself the original **Insights & Charts** design (2026-07-06, tiers C1–C11,
C9 dropped); it has been elevated in place to the as-built living-spec shape. Where the
shipped code diverged from that design — chart directory, the Sankey library, the C4 latency
semantics and endpoint, and the C5/C11 endpoint names — the `> ⚠️` notes above record the
as-built truth.
