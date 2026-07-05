# Insights & Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Insights page to the web console with 9 charts that visualise Magpie's knowledge-maintenance pipeline, backed by new API aggregation endpoints.

**Architecture:** A new `insights` Hono feature module in the API exposes read-only aggregation endpoints, each backed by SQL rollups in a Postgres-only insights store. Response types live in `@magpie/core`. A new App-Router `insights` page fetches its own data via `apiGet` (not `ConsoleProvider`) and renders charts with Recharts, plus one React Flow funnel reusing the existing `@xyflow/react` dependency.

**Tech Stack:** Hono, `pg` (raw SQL), `@magpie/core` shared types, Next 16 App Router, Emotion, **Recharts** (new dep), `@xyflow/react` + `@dagrejs/dagre` (existing).

**Companion spec:** `docs/insights-charts.md` — read it for the per-chart operator questions, source tables, and locked decisions.

## Global Constraints

- Node ≥ 22.13, ESM/NodeNext, TypeScript strict. Never cast through `unknown`/`any`.
- Every API read endpoint guarded with `requireScopes("read:knowledge")`.
- Every endpoint returns a named-key JSON envelope, e.g. `c.json({ series })`.
- Shared types declared once in `@magpie/core` (`packages/core/src/index.ts`), imported by both API and web. No duplication.
- Time params: `?from=<ISO>&to=<ISO>&bucket=day|week|month`; default last 30 days, `bucket=day`. Empty buckets zero-filled server-side.
- v1 UI uses a fixed "last 30 days" window — no range picker.
- Insights data is fetched page-locally on mount + manual refresh; NOT added to `ConsoleProvider`'s 4s poll.
- On-demand SQL — no materialised views/caching in v1.
- Validate with `npm run typecheck`, `npm run build`, `npm test`, `npm run lint` as you go. Commit and push little and often.

---

## File Structure

**API (new):**
- `apps/api/src/features/insights/routes.ts` — `insightsRoutes(ctx): Hono`, one route per chart.
- `apps/api/src/features/insights/service.ts` — thin pass-through to the store (validation, defaults).
- `apps/api/src/features/insights/schema.ts` — zod schemas for query params.
- `apps/api/src/stores/insights-store.ts` — `InsightsStore` interface + `NullInsightsStore` (empty results when no pool).
- `apps/api/src/stores/postgres-insights-store.ts` — `PostgresInsightsStore` implements the SQL rollups.
- `apps/api/src/stores/postgres-insights-store.integration.test.ts` — DB-backed rollup tests.

**API (modified):**
- `apps/api/src/platform/stores.ts` — add `createInsightsStore(config, pool)`.
- `apps/api/src/context.ts` — wire `insights` store into `stores` and `AppContext`.
- `apps/api/src/app.ts` — register `api.route("/insights", insightsRoutes(ctx))`.

**Core (modified):**
- `packages/core/src/index.ts` — add insights response types (`TimeBucket`, `GapBacklogBucket`, `JobThroughputBucket`, `FunnelStage`, `LatencyBin`, `VerificationSummary`, `JobErrorBreakdown`, `FreshnessSummary`, `PatrolImpact`, `WorkerUtilBucket`).

**Web (new):**
- `apps/web/src/app/insights/page.tsx` — the Insights page (page-local fetch).
- `apps/web/src/components/insights/useInsights.ts` — page-local fetch hook.
- `apps/web/src/components/insights/GapBacklogChart.tsx` and one component per chart.
- `apps/web/src/components/insights/ChartCard.tsx` — shared card chrome (title, empty/loading states).
- Colocated `*.test.tsx` per chart component.

**Web (modified):**
- `apps/web/package.json` — add `recharts`.
- `apps/web/src/lib/types.ts` — add `"insights"` to `ConsoleSection`; re-export insights types from `@magpie/core`.
- `apps/web/src/lib/sections.ts` — add the Insights nav entry.
- `apps/web/src/lib/console.ts` — add Insights title + subtitle.

---

## Phase 1 — Tier 1 (prove the stack, then the pipeline story)

### Task 1: Shared insights types in `@magpie/core`

**Files:**
- Modify: `packages/core/src/index.ts` (append near the other shared interfaces)
- Test: none (type-only; covered by API/web consumers)

**Interfaces — Produces:**
```ts
export type InsightsBucketUnit = "day" | "week" | "month";

export interface GapBacklogBucket {
  bucketStart: string; // ISO timestamp of the bucket's start
  opened: number;      // gaps created in this bucket
  resolved: number;    // gaps resolved in this bucket
  dismissed: number;   // gaps dismissed in this bucket
  parked: number;      // gaps parked in this bucket
  openTotal: number;   // cumulative gaps still open at the end of this bucket
}

export interface JobThroughputBucket {
  bucketStart: string;
  completed: number;
  failed: number;
  active: number;
  retry: number;
}

export interface FunnelStage {
  key: "questions" | "gaps" | "clustered" | "proposals" | "prs" | "merged" | "verified";
  label: string;
  count: number;
}
```

- [ ] **Step 1: Add the interfaces above to `packages/core/src/index.ts`.**
- [ ] **Step 2: Build core.** Run: `npm run build -w @magpie/core` — Expected: PASS.
- [ ] **Step 3: Commit.** `git add packages/core/src/index.ts && git commit -m "feat(insights): add shared chart response types"`

### Task 2: Insights store interface + null implementation

**Files:**
- Create: `apps/api/src/stores/insights-store.ts`
- Test: none yet (interface only)

**Interfaces — Produces:**
```ts
import type { GapBacklogBucket, InsightsBucketUnit, JobThroughputBucket, FunnelStage } from "@magpie/core";

export interface InsightsRange { from: Date; to: Date; bucket: InsightsBucketUnit; }

export interface InsightsStore {
  gapBacklog(range: InsightsRange, flowId?: string): Promise<GapBacklogBucket[]>;
  jobThroughput(range: InsightsRange, type?: string): Promise<JobThroughputBucket[]>;
  funnel(range: InsightsRange, flowId?: string): Promise<FunnelStage[]>;
}

// Used when the process runs with no Postgres pool (in-memory unit tests).
export class NullInsightsStore implements InsightsStore {
  async gapBacklog(): Promise<GapBacklogBucket[]> { return []; }
  async jobThroughput(): Promise<JobThroughputBucket[]> { return []; }
  async funnel(): Promise<FunnelStage[]> { return []; }
}
```

- [ ] **Step 1: Create the file with the interface + `NullInsightsStore`.**
- [ ] **Step 2: Typecheck.** Run: `npm run typecheck -w @magpie/api` — Expected: PASS.
- [ ] **Step 3: Commit.** `git add apps/api/src/stores/insights-store.ts && git commit -m "feat(insights): add InsightsStore interface + null impl"`

### Task 3: `date_trunc` bucket helper + Postgres store scaffold (gap backlog first)

**Files:**
- Create: `apps/api/src/stores/postgres-insights-store.ts`
- Test: `apps/api/src/stores/postgres-insights-store.integration.test.ts`

**Interfaces — Consumes:** `InsightsStore`, `InsightsRange` (Task 2), `pg.Pool`.

The gap-backlog query buckets `question_gaps` by `date_trunc`, counting each lifecycle transition per bucket and the running open total. `generate_series` produces zero-filled buckets so the client renders a continuous line.

- [ ] **Step 1: Write the failing integration test.**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresInsightsStore } from "./postgres-insights-store.js";

const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "";

test("gapBacklog buckets question_gaps by day", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const store = new PostgresInsightsStore(pool);

  // Seed: 1 question, 2 gaps created "today", 1 resolved.
  const q = "insights-test-q1";
  await pool.query("DELETE FROM question_gaps WHERE question_id = $1", [q]);
  await pool.query("DELETE FROM questions WHERE id = $1", [q]);
  await pool.query(
    "INSERT INTO questions (id, question, asked_at) VALUES ($1, 'q', now())",
    [q]
  );
  await pool.query(
    "INSERT INTO question_gaps (question_id, summary, created_at, resolved_at) VALUES ($1,'a',now(),NULL),($1,'b',now(),now())",
    [q]
  );

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  const rows = await store.gapBacklog({ from, to, bucket: "day" });

  const today = rows.at(-1);
  assert.ok(today);
  assert.equal(today.opened, 2);
  assert.equal(today.resolved, 1);
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run: `RUN_PG_INTEGRATION=1 npm test -w @magpie/api -- --test-name-pattern gapBacklog` — Expected: FAIL (module not found / no such export).

- [ ] **Step 3: Implement `PostgresInsightsStore.gapBacklog`.**

```ts
import pg from "pg";
import type { GapBacklogBucket } from "@magpie/core";
import type { InsightsRange, InsightsStore } from "./insights-store.js";

// date_trunc units map 1:1 to our bucket units; the whitelist below keeps the
// unit out of interpolation risk (it is validated by the zod schema too).
const UNIT: Record<InsightsRange["bucket"], string> = { day: "day", week: "week", month: "month" };

export class PostgresInsightsStore implements InsightsStore {
  constructor(private readonly pool: pg.Pool) {}

  async gapBacklog(range: InsightsRange, flowId?: string): Promise<GapBacklogBucket[]> {
    const unit = UNIT[range.bucket];
    const result = await this.pool.query<{
      bucket_start: Date; opened: string; resolved: string; dismissed: string; parked: string; open_total: string;
    }>(
      `
      WITH buckets AS (
        SELECT generate_series(date_trunc($3, $1::timestamptz), date_trunc($3, $2::timestamptz), ('1 ' || $3)::interval) AS bucket_start
      ),
      per_bucket AS (
        SELECT b.bucket_start,
          count(*) FILTER (WHERE date_trunc($3, g.created_at) = b.bucket_start) AS opened,
          count(*) FILTER (WHERE date_trunc($3, g.resolved_at) = b.bucket_start) AS resolved,
          count(*) FILTER (WHERE date_trunc($3, g.dismissed_at) = b.bucket_start) AS dismissed,
          count(*) FILTER (WHERE date_trunc($3, g.parked_at) = b.bucket_start) AS parked
        FROM buckets b
        LEFT JOIN question_gaps g ON true
        LEFT JOIN questions q ON q.id = g.question_id
        WHERE ($4::text IS NULL OR q.flow_id = $4)
        GROUP BY b.bucket_start
      )
      SELECT bucket_start, opened, resolved, dismissed, parked,
        sum(opened - resolved - dismissed - parked) OVER (ORDER BY bucket_start) AS open_total
      FROM per_bucket ORDER BY bucket_start
      `,
      [range.from.toISOString(), range.to.toISOString(), unit, flowId ?? null]
    );
    return result.rows.map((r) => ({
      bucketStart: r.bucket_start.toISOString(),
      opened: Number(r.opened), resolved: Number(r.resolved),
      dismissed: Number(r.dismissed), parked: Number(r.parked), openTotal: Number(r.open_total)
    }));
  }

  async jobThroughput(): Promise<[]> { return []; } // Task 5
  async funnel(): Promise<[]> { return []; }         // Task 6
}
```

> Note during implementation: the `LEFT JOIN question_gaps ON true` cross-join above is a documentation sketch — the real query must correlate the per-bucket FILTER counts without multiplying rows. Implement with a `LEFT JOIN question_gaps g ON date_trunc($3, g.created_at) BETWEEN … ` or a lateral count per bucket, and let the integration test in Step 1 gate correctness. Do not ship until Step 4 passes.

- [ ] **Step 4: Run the test to verify it passes.** Run: `RUN_PG_INTEGRATION=1 npm test -w @magpie/api -- --test-name-pattern gapBacklog` — Expected: PASS.
- [ ] **Step 5: Commit.** `git add apps/api/src/stores/postgres-insights-store.ts apps/api/src/stores/postgres-insights-store.integration.test.ts && git commit -m "feat(insights): gap-backlog rollup query"`

### Task 4: Wire the store into the factory, context, and register routes

**Files:**
- Modify: `apps/api/src/platform/stores.ts`, `apps/api/src/context.ts`, `apps/api/src/app.ts`
- Create: `apps/api/src/features/insights/{schema.ts,service.ts,routes.ts}`
- Test: `apps/api/src/features/insights/routes.test.ts` (Hono unit test — envelope + param validation using `makeTestContext`, which yields a `NullInsightsStore`)

**Interfaces — Consumes:** `InsightsStore` (Task 2). **Produces:** `GET /api/insights/gaps/backlog` → `{ series: GapBacklogBucket[] }`.

- [ ] **Step 1: Add `createInsightsStore(config, pool)` to `platform/stores.ts`** returning `PostgresInsightsStore` when a pool is Postgres-backed, else `NullInsightsStore`. Mirror `createSnapshotStore`.
- [ ] **Step 2: Wire `insights` into `context.ts`** — add to the `stores` type and construct it alongside the others.
- [ ] **Step 3: Add zod query schema** (`from`/`to`/`bucket`/`flow`, with 30-day defaults) in `schema.ts`, a thin `service.ts` that parses/defaults and calls `ctx.stores.insights`, and `routes.ts` with `app.get("/gaps/backlog", requireScopes("read:knowledge"), …)`.
- [ ] **Step 4: Register in `app.ts`:** `api.route("/insights", insightsRoutes(ctx))`.
- [ ] **Step 5: Write the Hono unit test** asserting `GET /api/insights/gaps/backlog` returns 200 `{ series: [] }` under the null store, and 400 on a bad `bucket`.
- [ ] **Step 6: Run tests + typecheck.** `npm test -w @magpie/api -- --test-name-pattern insights && npm run typecheck -w @magpie/api` — Expected: PASS.
- [ ] **Step 7: Commit + push.**

### Task 5: Recharts dep + Insights page shell + nav + gap-backlog chart (FIRST VISIBLE)

**Files:**
- Modify: `apps/web/package.json`, `apps/web/src/lib/types.ts`, `apps/web/src/lib/sections.ts`, `apps/web/src/lib/console.ts`
- Create: `apps/web/src/app/insights/page.tsx`, `apps/web/src/components/insights/{useInsights.ts,ChartCard.tsx,GapBacklogChart.tsx}`
- Test: `apps/web/src/components/insights/GapBacklogChart.test.tsx`

**Interfaces — Consumes:** `GET /api/insights/gaps/backlog` → `{ series: GapBacklogBucket[] }`.

- [ ] **Step 1: Add `recharts` to `apps/web/package.json` and install.** `npm install recharts -w @magpie/web`. Verify it declares React 19 support (peer deps) — Expected: no unmet-peer error against React 19.
- [ ] **Step 2: Add `"insights"` to `ConsoleSection`, a nav entry in `sections.ts` (group 2, near Activity), and title/subtitle in `console.ts`.**
- [ ] **Step 3: Write the failing component test** rendering `<GapBacklogChart series={fixture} />` and asserting it renders a heading and does not throw with empty data (`series={[]}` shows an empty-state message).
- [ ] **Step 4: Implement `useInsights` (page-local `apiGet` on mount + `refresh()`), `ChartCard`, and `GapBacklogChart`** (Recharts `AreaChart`: `opened`/`resolved`/`dismissed`/`parked` stacked, `openTotal` as a line; `"use client"`). The page composes them; it must NOT read `useConsole()`.
- [ ] **Step 5: Run the component test.** `npm test -w @magpie/web -- --test-name-pattern GapBacklog` — Expected: PASS.
- [ ] **Step 6: Typecheck + build web.** `npm run typecheck -w @magpie/web && npm run build -w @magpie/web` — Expected: PASS.
- [ ] **Step 7: Run the stack (run-magpie skill) and screenshot `/insights`.** Confirm the chart renders. Commit + push.

### Task 6: Job throughput chart (C2)

**Files:** `postgres-insights-store.ts` (`jobThroughput`), `insights/routes.ts` (+`/jobs/throughput`), `components/insights/JobThroughputChart.tsx`, tests.

- **Data source note:** jobs live in pg-boss's `"<schema>".job` **and** `"<schema>".archive` (completed/failed rows migrate to `archive` after retention). The throughput rollup MUST `UNION ALL` both tables, bucket by `date_trunc(created_on)`, and group by state — else completed jobs vanish from history. Read the pg-boss schema name from `ctx.jobs` config (see `apps/api/src/jobs/pg-boss-broker.ts`); guard it with the existing `SCHEMA_IDENTIFIER` regex.
- Endpoint: `GET /insights/jobs/throughput?from&to&bucket&type` → `{ series: JobThroughputBucket[] }`.
- Chart: Recharts stacked `AreaChart` (completed/failed/active/retry).
- Steps mirror Task 3 + Task 5 (TDD: failing integration test seeding pg-boss rows → implement → passing; failing component test → implement → passing → commit).

### Task 7: Gap-to-merge funnel (C1, React Flow)

**Files:** `postgres-insights-store.ts` (`funnel`), `insights/routes.ts` (+`/funnel`), `components/insights/GapFunnel.tsx` (uses `@xyflow/react` + `@dagrejs/dagre` for left-to-right layout), tests.

- Endpoint: `GET /insights/funnel?from&to&flow` → `{ stages: FunnelStage[] }`. One `count` per stage from `question_log`, `question_gaps`, `gap_cluster_memberships`, `proposals` (by status), `gap_closure_verification` (verdict='closed').
- Chart: a horizontal React Flow graph of 7 nodes with counts + drop-off %, styled to match the existing dataflow view.
- Steps mirror Task 3 + Task 5.

---

## Phase 2 — Tier 2 (quality & latency)

Each is one task = one endpoint (SQL rollup + integration test) + one component (+ component test) + register + commit, following the Phase-1 pattern. Data contracts are in `docs/insights-charts.md`.

### Task 8: Gap-resolution latency histogram (C4)
- `GET /insights/gaps/latency?from&to&flow` → `{ bins: LatencyBin[] }` where `LatencyBin = { label: string; from: number; to: number; count: number }` (days from gap `created_at` → resolving proposal `merged_at`). Recharts `BarChart`.

### Task 9: Verification success rate (C5)
- `GET /insights/verification?from&to&bucket` → `{ totals: VerificationSummary; series: (VerificationSummary & { bucketStart: string })[] }` where `VerificationSummary = { closed: number; stillOpen: number }`. From `gap_closure_verification.verdict`. Recharts donut (`PieChart`) + trend.

### Task 10: Job error breakdown (C6)
- `GET /insights/jobs/errors?from&to` → `{ byCategory: JobErrorBreakdown[]; byType: JobErrorBreakdown[] }` where `JobErrorBreakdown = { key: string; count: number }`. From failed pg-boss job rows' error payload (`error.category`, queue `name`). Union `job` + `archive` as in Task 6. Recharts `BarChart`.

---

## Phase 3 — Tier 3 (freshness & operations)

### Task 11: Knowledge-base freshness (C7)
- `GET /insights/freshness` → `{ documents: { fresh: number; due: number; overdue: number }; sources: { fresh: number; stale: number } }`. From `documents` (`last_verified` + `review_cycle_days`) and `source_sync_state.last_checked_at`. Recharts `BarChart`.

### Task 12: Maintenance patrol impact (C8)
- `GET /insights/patrols?from&to` → `{ runs: PatrolImpact[] }` where `PatrolImpact = { taskType: string; runs: number; findings: number; proposals: number }`. From `maintenance_runs` (`task_type`, `details` JSONB). Recharts grouped `BarChart`.

### Task 13: Worker utilisation (C9) — CONDITIONAL
- **First** confirm the watcher persists heartbeat samples (`lastSeenAt`/`currentJobId`) durably enough for a time-series. If NOT, **drop this task** — do not add a sampling table (spec §C9 decision). If yes: `GET /insights/workers?from&to&bucket` → `{ series: WorkerUtilBucket[] }` where `WorkerUtilBucket = { bucketStart: string; workerName: string; busyRatio: number }`. Recharts line-per-worker.

---

## Docs

### Task 14: Documentation
- Update `docs/api.md` with the `/insights/*` endpoints and their response shapes.
- Add an "Insights" section describing each chart and its source data.
- Mark the spec (`docs/insights-charts.md`) status Implemented.

---

## Self-Review Notes

- **Spec coverage:** all 9 charts (C1–C9) map to Tasks 5–13; single Insights page = Task 5 shell; new endpoints = Tasks 3–13; page-local fetch = Task 5 `useInsights`; fixed 30-day window = Task 4 schema defaults + Task 5 page.
- **Type consistency:** response types defined once in Task 1 / `@magpie/core`; store method names (`gapBacklog`, `jobThroughput`, `funnel`, …) are stable across store, service, routes.
- **Known risk called out:** pg-boss `job`+`archive` union (Tasks 6, 10) and the gap-backlog correlated-count query (Task 3 note) are the two places to verify carefully against the integration tests before shipping.
</content>
