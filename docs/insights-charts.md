# Insights & Charts — Specification

**Status:** Implemented (C1–C8, C10). C9 dropped — see §C9 and §10.2.
**Date:** 2026-07-06
**Owner:** Adam

## 1. Goal

Add a dedicated **Insights** page to the web app that visualises the health and
progress of Magpie's knowledge-maintenance pipeline. Today the UI is table- and
list-oriented (Jobs, Gaps, Proposals, Activity, Reconciliations). None of it
shows *trends over time*, *funnel conversion*, *distributions*, or *success
rates* — exactly the questions an operator most wants answered.

## 2. Why these visuals (framing)

Magpie is a **pipeline**, not a metrics dashboard:

```
question → gap → cluster → proposal → PR → merged → verified-closed
```

…driven by an async job queue (`ai_jobs`) with scheduled patrols on a cadence.
So the highest-value visuals are **flow/funnel** and **health-over-time**, not
vanity KPIs. The charts below all answer a concrete operator question ("is the
backlog growing?", "are merged proposals actually closing the gap?", "what's
breaking?").

## 3. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Charting library | **Recharts** for quantitative charts | React-19 / Next-16 friendly, SVG, themeable via Emotion, low adoption cost, declarative. Avoids pulling in the MUI ecosystem just for charts. |
| Flow diagram | **Reuse `@xyflow/react` (React Flow) + dagre** | Already a dependency; keeps the funnel visually consistent with existing graph views; no new Sankey dependency. |
| Scope | **All 9 charts**, delivered in 3 tiers | Tier 1 first to prove the stack, then 2 and 3. |
| Data source | **New API aggregation endpoints** | The charts need server-side SQL rollups; the current endpoints return row lists, not aggregates. |
| UI placement | **Single dedicated Insights page** | All charts on one dashboard route; existing pages unchanged. |

## 4. Architecture

- **New API feature module** `apps/api/src/features/insights/` following the
  existing Hono pattern: `routes.ts` exports `insightsRoutes(ctx): Hono`,
  registered in `apps/api/src/app.ts` via `api.route("/insights", …)`.
- **Aggregation lives in a store** `apps/api/src/stores/postgres-insights-store.ts`
  using `pg.Pool` and parametrized SQL (`$1`, `::int` casts, `date_trunc` for
  time-binning) — mirroring the aggregation style already in
  `postgres-question-log-store.ts` (`listGapCandidates`).
- **Response types** declared once in `@magpie/core` (`packages/core/src/index.ts`)
  and imported by both API and web. Every endpoint returns a named-key envelope,
  e.g. `c.json({ series: [...] })`.
- **Web**: new route `apps/web/src/app/insights/page.tsx` (`"use client"`). It
  fetches via the shared `apiGet<T>` client in `apps/web/src/lib/api.ts`.
  Chart components live in `apps/web/src/components/charts/`.
- **Auth**: all read endpoints guarded with `requireScopes("read:knowledge")`,
  matching sibling read routes.

### Data-fetching approach (decided)

The Insights page fetches its own data on mount via `apiGet` — **not** through
`ConsoleProvider` — with a manual refresh button. This keeps the heavier,
slower-moving aggregates out of the global 4s poll. No background polling in v1.

## 5. Shared query conventions

- **Time range**: endpoints accept `?from=<ISO>&to=<ISO>&bucket=day|week|month`
  (default: last 30 days, `bucket=day`). Bucketing via `date_trunc($bucket, ts)`.
  **v1 UI uses a fixed "last 30 days" window** — no range picker; the params
  exist on the API for later.
- **Flow filter**: optional `?flow=<flowId>` where the entity carries a flow.
- All timestamps returned as ISO strings; all counts as integers.
- Empty buckets are zero-filled server-side so the client renders continuous
  series.

## 6. The charts

Each entry: the operator question, the chart type, the endpoint, and the source
data. Data inventory confirmed against the schema (see the tables named below).

### Tier 1 — the pipeline story

**C1. Question journey** *(Recharts Sankey)*
- **Question:** What path does a question take, and where does volume leak at each branch — answered confidently, dismissed, parked, rejected, reopened?
- **Segments:** answer (questions split by `confidence`, then no-gap vs gap-raised) → gap (dismissed / parked / open / clustered) → proposal (in-progress / rejected / superseded / merged) → verify (verified-closed / reopened / needs-attention / awaiting). Link widths are real counts; the unit shifts question → gap → proposal across the graph (labelled on the chart). Each unit shift is carried on the *link* at a segment boundary, not inside a node: the `clustered → proposals` link carries the gap-side count (clustered gaps handed off), so the "Clustered" node stays internally conserved (a Sankey node is sized by `max(in, out)`) instead of ballooning to the proposal total. The shift to `prop_total` surfaces at "Proposals drafted", where the outgoing status arms sum. Proposals are windowed independently on their own `created_at`, so that total is not conserved against clustered gaps by design.
- **Endpoint:** `GET /insights/journey?from&to&flow` → `{ nodes: JourneyNode[], links: JourneyLink[] }`.
- **Source:** `questions` (`asked_at`, `confidence`), `question_gaps` (terminal timestamps), `gap_cluster_memberships` (`active`), `proposals` (`status`, `closure_status`). Replaces the earlier linear gap-to-merge funnel — a strict superset that also shows disposition, not just drop-off.

**C2. Job throughput & health** *(Recharts stacked area, time-series)*
- **Question:** Is the queue keeping up? Is a runner failing?
- **Series:** `ai_jobs` bucketed by time, stacked by state (completed / failed / active / retry).
- **Endpoint:** `GET /insights/jobs/throughput?from&to&bucket&type` → `{ series: JobThroughputBucket[] }`.
- **Source:** `ai_jobs` (`created_at`, `started_at`, `completed_at`, `failedAt`, `state`, `type`).

**C3. Open-gap backlog trend** *(Recharts line/area, time-series)*
- **Question:** Is knowledge debt growing or shrinking?
- **Series:** count of gaps in each state (open / resolved / parked / dismissed) per bucket.
- **Endpoint:** `GET /insights/gaps/backlog?from&to&bucket&flow` → `{ series: GapBacklogBucket[] }`.
- **Source:** `question_gaps` (`created_at`, `resolved_at`, `dismissed_at`, `parked_at`).

### Tier 2 — quality & latency

**C4. Gap-resolution latency histogram** *(Recharts bar)*
- **Question:** How long do gaps take to close? Where's the slow tail?
- **Data:** distribution of days from gap `created_at` → proposal `merged_at`, binned.
- **Endpoint:** `GET /insights/gaps/latency?from&to&flow` → `{ bins: LatencyBin[] }`.
- **Source:** `question_gaps`, `proposals`.

**C5. Verification success rate** *(Recharts donut + trend)*
- **Question:** Do merged proposals actually close the gap they targeted?
- **Data:** `gap_closure_verification` verdict split (closed vs still_open), overall and over time.
- **Endpoint:** `GET /insights/verification?from&to&bucket` → `{ totals: {...}, series: VerificationBucket[] }`.
- **Source:** `gap_closure_verification` (`verdict`, `confidence`, `created_at`).

**C6. Job error breakdown** *(Recharts bar)*
- **Question:** What's breaking, and in which job type?
- **Data:** failed-job counts grouped by `error.category` (provider / validation / timeout / external / internal) and by job type.
- **Endpoint:** `GET /insights/jobs/errors?from&to` → `{ byCategory: [...], byType: [...] }`.
- **Source:** `ai_jobs` (failed rows, error metadata).

### Tier 3 — freshness & operations

**C7. Knowledge-base freshness** *(Recharts bar)*
- **Question:** How much of the KB is overdue for review? Which sources are stale?
- **Data:** documents bucketed by review-cycle compliance (fresh / due / overdue via `last_verified` + `review_cycle_days`); sources not synced in N days.
- **Endpoint:** `GET /insights/freshness` → `{ documents: {...}, sources: {...} }`.
- **Source:** `documents`, `source_sync_state`.

**C8. Maintenance patrol impact** *(Recharts)*
- **Question:** Are the patrols finding and fixing things?
- **Data:** coverage per run and findings→proposals conversion for correctness/editorial patrols.
- **Endpoint:** `GET /insights/patrols?from&to` → `{ runs: PatrolImpact[] }`.
- **Source:** `maintenance_runs` (`task_type`, `details` JSONB, timestamps).

**C9. Worker utilisation** *(Recharts, time-series)* — **DROPPED (no durable heartbeat samples)**
- **Question:** Are workers saturated or idle?
- **Data:** busy ratio per worker over time (fraction of samples with an active job).
- **Endpoint (not built):** `GET /insights/workers?from&to&bucket` → `{ series: WorkerUtilBucket[] }`.
- **Source:** watcher/worker heartbeat data (`lastSeenAt`, `currentJobId`).
- **Decision (resolved):** dropped per the locked conditional. The only heartbeat
  store is `watcher_registrations` (migration `0025_watcher_registry.sql`), which
  the API **upserts** one row per watcher on every claim/heartbeat and prunes stale
  rows on read — it holds only each watcher's *latest* `last_seen_at` /
  `current_job_id`, not a durable time-series of samples. A busy-ratio-over-time
  chart would require a new sampling table, which §10.2 explicitly rules out for
  this work. No endpoint, store method, or component was built, and no data was
  fabricated.

**C10. Answer feedback** *(Recharts stacked area + rate line, time-series)* — added later (#241)
- **Question:** Are users rejecting the answers — and especially the answers the system was confident in?
- **Data:** live questions' helpful/unhelpful verdicts per bucket (windowed on `feedback_at`), the `unhelpful` stack split into confident-answer rejections (`confidence` high/medium — the subset that also raises a `feedback` gap, see `docs/question-logging.md`) and the rest, plus an unhelpful-rate line. Verification re-asks excluded.
- **Endpoint:** `GET /insights/feedback?from&to&bucket&flow` → `{ totals: FeedbackSummary, series: FeedbackBucket[] }`.
- **Source:** `questions` (`feedback`, `feedback_at`, `confidence`, `purpose`).

## 7. Delivery phases

1. **Phase 1 (Tier 1):** insights feature module + store scaffolding, `@magpie/core`
   types, Insights page shell with page-local fetching, C2 (throughput —
   proves Recharts + Next 16 SSR), then C3 and C1 (funnel via React Flow).
2. **Phase 2 (Tier 2):** C4, C5, C6.
3. **Phase 3 (Tier 3):** C7, C8, C9.

Each chart is independently shippable: one endpoint + one component + tests.

## 8. Testing

- **API:** endpoint tests beside the code (`postgres-insights-store.integration.test.ts`,
  gated by `RUN_PG_INTEGRATION=1`) for the SQL rollups against seeded data;
  a unit test in the Hono app (`buildApp(makeTestContext())`) for envelope shape
  and param validation, following `apps/api/src/app.test.ts`.
- **Web:** component tests under `apps/web` (`node:test` + `.test.tsx`) rendering
  each chart with fixture series and asserting it renders without error and shows
  expected labels/empty-states.

## 9. Documentation

- Update `docs/api.md` with the new `/insights/*` endpoints.
- Add an "Insights" section to the web/app docs describing each chart and its
  source data.

## 10. Resolved decisions

1. **Data-fetch model:** page-local fetch on mount + manual refresh, not via
   `ConsoleProvider`. (See §4.)
2. **Worker utilisation (C9):** conditional — if the watcher doesn't already
   persist heartbeat samples durably, drop the chart; no new sampling table. (See C9.)
3. **Time window:** fixed "last 30 days" in v1; no range picker. (See §5.)
4. **Performance:** on-demand SQL for v1; optimise (caching / materialised
   views) later only if needed.
```
