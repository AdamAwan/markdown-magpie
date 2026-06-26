# Generic Maintenance-Run Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bespoke `PatrolRun` (and, in a later project, `SourceSyncRun`) records with one generic `MaintenanceRun` execution-audit table, write it from the patrol and gaps→PR ticks, and surface run history on the Schedules page.

**Architecture:** A new `MaintenanceRun` core type + `MaintenanceRunStore` (in-memory + Postgres) replaces the patrol store's run methods. The patrol service and the gap reconciler record runs into it; a new `GET /api/maintenance-runs` lists them; the Schedules page renders them. Source-sync is untouched (migrates with project B).

**Tech Stack:** TypeScript, Node test runner, Zod (API request validation), npm workspaces (`@magpie/core`, `@magpie/api`, web), Postgres migrations, Hono routes, React (Next.js) web console.

## Global Constraints

- TDD: RED first on every behaviour change; watch it fail before implementing.
- Run package tests from repo root via `npm test -w <pkg>` or `node --import tsx --test <file>`; root-cwd globs resolve stale dist. **Rebuild changed leaf packages (`@magpie/core`) before running API tests** — API tests resolve `@magpie/*` from `dist`.
- Postgres store tests self-skip without `DATABASE_URL`.
- `npm run deadcode` (knip STRICT) must stay clean — fix orphaned exports by de-exporting/deleting, never by relaxing config.
- Web is type-checked separately: `npm run typecheck -w @magpie/web` (the root typecheck excludes `apps/web`).
- A `MaintenanceRun` is an execution audit only — no proposal/PR lifecycle fields.
- `MaintenanceTaskType = "fix_patrol" | "improve_patrol" | "process_gaps_to_pull_requests"` (project B adds `"source_change_sync"`).
- Status values: `"running" | "completed" | "failed"`; project-A writers only ever write `completed`/`failed` atomically.

---

### Task 1: Core MaintenanceRun type

**Files:**
- Modify: `packages/core/src/index.ts` (add types near the existing `PatrolRun`)

**Interfaces:**
- Produces: `MaintenanceTaskType`, `MaintenanceRun`, `NewMaintenanceRun`.

- [ ] **Step 1: Add the types**

```ts
export type MaintenanceTaskType = "fix_patrol" | "improve_patrol" | "process_gaps_to_pull_requests";

export type MaintenanceRunStatus = "running" | "completed" | "failed";

export interface MaintenanceRun {
  id: string;
  taskType: MaintenanceTaskType;
  flowId?: string;
  trigger: "scheduled" | "manual";
  status: MaintenanceRunStatus;
  // One-line human summary, e.g. "checked 5/40 docs · 1 finding".
  summary: string;
  error?: string;
  // Task-specific payload (JSONB in Postgres). Open by design so each task records
  // what it has without widening the shared shape.
  details: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}

export type NewMaintenanceRun = Omit<MaintenanceRun, "id" | "startedAt"> & { startedAt?: string };
```

- [ ] **Step 2: Build core and typecheck**

Run: `npm run build -w @magpie/core && npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add MaintenanceRun audit type"
```

---

### Task 2: In-memory MaintenanceRunStore + wiring

**Files:**
- Create: `apps/api/src/stores/maintenance-run-store.ts`
- Create: `apps/api/src/stores/maintenance-run-store.test.ts`
- Modify: `apps/api/src/platform/stores.ts` (add `MAINTENANCE_RUN_STORE` to `StoreEnvName`, add `createMaintenanceRunStore`)
- Modify: `apps/api/src/context.ts` (import factory, add `maintenanceRuns` to the stores type + init)
- Modify: `apps/api/src/test-support/context.ts` (init `maintenanceRuns: new InMemoryMaintenanceRunStore()`)

**Interfaces:**
- Consumes: `MaintenanceRun`, `NewMaintenanceRun`, `MaintenanceTaskType` (Task 1).
- Produces: `MaintenanceRunStore` with `record(input: NewMaintenanceRun): Promise<MaintenanceRun>`, `list(filters: { taskType?: MaintenanceTaskType; flowId?: string; limit: number }): Promise<MaintenanceRun[]>`, `get(id: string): Promise<MaintenanceRun | undefined>`, `reset(): Promise<void>`; `InMemoryMaintenanceRunStore`; `createMaintenanceRunStore()`.

- [ ] **Step 1: Write the failing store test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryMaintenanceRunStore } from "./maintenance-run-store.js";

test("records and lists runs newest-first, filtered by task type and flow", async () => {
  const store = new InMemoryMaintenanceRunStore();
  const a = await store.record({ taskType: "fix_patrol", flowId: "f1", trigger: "scheduled", status: "completed", summary: "a", details: {} });
  await store.record({ taskType: "improve_patrol", flowId: "f1", trigger: "scheduled", status: "completed", summary: "b", details: {} });
  const c = await store.record({ taskType: "fix_patrol", trigger: "manual", status: "failed", summary: "c", error: "boom", details: {} });

  const all = await store.list({ limit: 10 });
  assert.deepEqual(all.map((r) => r.summary), ["c", "b", "a"]);
  const fix = await store.list({ taskType: "fix_patrol", limit: 10 });
  assert.deepEqual(fix.map((r) => r.summary), ["c", "a"]);
  const f1 = await store.list({ flowId: "f1", limit: 10 });
  assert.deepEqual(f1.map((r) => r.summary), ["b", "a"]);
  assert.equal((await store.get(a.id))?.summary, "a");
  assert.equal((await store.get(c.id))?.error, "boom");
});
```

Run: `node --import tsx --test apps/api/src/stores/maintenance-run-store.test.ts`
Expected: FAIL — module not found / `InMemoryMaintenanceRunStore` not exported.

- [ ] **Step 2: Implement the in-memory store**

Model it on `reconciliation-decision-store.ts` (seq counter for stable newest-first). `record` fills `id` (`randomUUID()`), `startedAt` (now, unless supplied), `completedAt` (now when status is terminal). `list` reverses insertion order, applies `taskType`/`flowId` filters, then `slice(0, limit)`.

```ts
import { randomUUID } from "node:crypto";
import type { MaintenanceRun, MaintenanceTaskType, NewMaintenanceRun } from "@magpie/core";

export interface MaintenanceRunStore {
  record(input: NewMaintenanceRun): Promise<MaintenanceRun>;
  list(filters: { taskType?: MaintenanceTaskType; flowId?: string; limit: number }): Promise<MaintenanceRun[]>;
  get(id: string): Promise<MaintenanceRun | undefined>;
  reset(): Promise<void>;
}

export class InMemoryMaintenanceRunStore implements MaintenanceRunStore {
  private readonly runs: MaintenanceRun[] = [];

  async record(input: NewMaintenanceRun): Promise<MaintenanceRun> {
    const now = new Date().toISOString();
    const run: MaintenanceRun = {
      ...input,
      id: randomUUID(),
      startedAt: input.startedAt ?? now,
      completedAt: input.completedAt ?? (input.status === "running" ? undefined : now)
    };
    this.runs.push(run);
    return run;
  }

  async list(filters: { taskType?: MaintenanceTaskType; flowId?: string; limit: number }): Promise<MaintenanceRun[]> {
    return [...this.runs]
      .reverse()
      .filter((r) => (filters.taskType ? r.taskType === filters.taskType : true))
      .filter((r) => (filters.flowId !== undefined ? r.flowId === filters.flowId : true))
      .slice(0, filters.limit);
  }

  async get(id: string): Promise<MaintenanceRun | undefined> {
    return this.runs.find((r) => r.id === id);
  }

  async reset(): Promise<void> {
    this.runs.length = 0;
  }
}
```

- [ ] **Step 3: Wire factory + context**

In `platform/stores.ts`: add `| "MAINTENANCE_RUN_STORE"` to `StoreEnvName`, and a `createMaintenanceRunStore()` returning `InMemoryMaintenanceRunStore | PostgresMaintenanceRunStore` (Postgres import lands in Task 3 — for now point both arms at the in-memory store, or add the Postgres import in Task 3; to keep this task green, import only the in-memory store and return it from both arms, then swap the postgres arm in Task 3).

In `context.ts`: import `createMaintenanceRunStore`, add `maintenanceRuns: ReturnType<typeof createMaintenanceRunStore>;` to the stores type and `maintenanceRuns: createMaintenanceRunStore(),` to the init.

In `test-support/context.ts`: import `InMemoryMaintenanceRunStore`, add `maintenanceRuns: new InMemoryMaintenanceRunStore(),`.

- [ ] **Step 4: Run test + typecheck**

Run: `node --import tsx --test apps/api/src/stores/maintenance-run-store.test.ts` then `npm run typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): add in-memory MaintenanceRunStore and wiring"
```

---

### Task 3: Postgres store + migration

**Files:**
- Create: `packages/db/migrations/0032_maintenance_runs.sql`
- Create: `apps/api/src/stores/postgres-maintenance-run-store.ts`
- Create: `apps/api/src/stores/postgres-maintenance-run-store.test.ts`
- Modify: `apps/api/src/platform/stores.ts` (point the postgres arm of `createMaintenanceRunStore` at `PostgresMaintenanceRunStore`)

**Interfaces:**
- Consumes: `MaintenanceRunStore`, `NewMaintenanceRun` (Task 2).
- Produces: `PostgresMaintenanceRunStore implements MaintenanceRunStore`.

- [ ] **Step 1: Write the migration**

```sql
-- Generic maintenance-run audit. Replaces the bespoke patrol_runs table; the
-- source_sync_runs table migrates later with Scope B. Dropping patrol_runs data
-- is acceptable (no production data yet).
CREATE TABLE IF NOT EXISTS maintenance_runs (
  id text PRIMARY KEY,
  task_type text NOT NULL,
  flow_id text,
  trigger text NOT NULL,
  status text NOT NULL,
  summary text NOT NULL DEFAULT '',
  error text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS maintenance_runs_task_started_idx ON maintenance_runs (task_type, started_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_runs_flow_started_idx ON maintenance_runs (flow_id, started_at DESC);

DROP TABLE IF EXISTS patrol_runs;
```

- [ ] **Step 2: Write the failing Postgres test (self-skipping)**

Model on `postgres-source-sync-store.test.ts`: `describe("PostgresMaintenanceRunStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, ...)`. Insert two runs, assert `list` newest-first + `taskType` filter + `get`.

Run: `node --import tsx --test apps/api/src/stores/postgres-maintenance-run-store.test.ts`
Expected: SKIP (no `DATABASE_URL`) or FAIL (store not implemented) if `DATABASE_URL` is set.

- [ ] **Step 3: Implement the Postgres store**

Mirror `postgres-source-sync-store.ts` (a `pg` Pool, `mapRow` from snake_case columns, `details` round-tripped as jsonb). Methods: `record` (INSERT … RETURNING *), `list` (WHERE optional task_type/flow_id, ORDER BY started_at DESC LIMIT), `get` (by id), `reset` (DELETE). Point the postgres arm of `createMaintenanceRunStore` at it.

- [ ] **Step 4: Verify**

Run: `npm run typecheck` ; `node --import tsx --test apps/api/src/stores/postgres-maintenance-run-store.test.ts`
Expected: typecheck exit 0; store test passes or self-skips.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): add Postgres MaintenanceRunStore + migration 0032"
```

---

### Task 4: Patrol writes MaintenanceRun; retire PatrolRun

**Files:**
- Modify: `apps/api/src/features/patrol/service.ts` (record into `maintenanceRuns`; update `FixPatrolOutcome`/`ImprovePatrolOutcome`; `listRuns`/`getRun` read the maintenance store)
- Modify: `apps/api/src/features/patrol/routes.ts` (response counts from the outcome; `/runs` lists fix+improve maintenance runs)
- Modify: `apps/api/src/features/patrol/service.test.ts` (assert a MaintenanceRun is recorded)
- Modify: `apps/api/src/stores/patrol-store.ts` (remove `createRun`/`listRuns`/`getRun` + `PatrolRunInput`; keep cursor)
- Modify: `apps/api/src/stores/patrol-store.test.ts` (drop run-method tests; keep cursor tests)
- Modify: `packages/core/src/index.ts` (remove `PatrolRun`; keep `VerifyFinding`)
- Modify: `apps/api/src/stores/postgres-patrol-store.ts` (remove run methods + row mapping; keep cursor)
- Modify: `apps/api/src/stores/postgres-patrol-store.test.ts` (drop run tests)

**Interfaces:**
- Consumes: `ctx.stores.maintenanceRuns.record/list/get` (Task 2).
- Produces: `FixPatrolOutcome = { ok: true; selectedCount: number; findingCount: number; runId: string } | { ok: false; code: "unknown_flow" }`; `ImprovePatrolOutcome = { ok: true; selectedCount: number; enqueuedCount: number; runId: string } | { ok: false; code: "unknown_flow" }`. `listRuns(ctx, { taskType?, limit }): Promise<MaintenanceRun[]>`, `getRun(ctx, id): Promise<MaintenanceRun | undefined>`.

- [ ] **Step 1: Update the patrol service test (RED)**

Replace the `PatrolRun`/`patrol.listRuns` assertions with maintenance-store ones, e.g.:

```ts
const outcome = await runFixPatrol(ctx, { flowId: undefined, trigger: "scheduled" }, { verifyDocument: fakeVerify });
assert.ok(outcome.ok);
const runs = await ctx.stores.maintenanceRuns.list({ taskType: "fix_patrol", limit: 10 });
assert.equal(runs.length, 1);
assert.equal(runs[0].details.findings instanceof Array || Array.isArray((runs[0].details as any).findings), true);
assert.equal(outcome.findingCount, runs[0].details.findings.length ?? 0);
```

(Match the existing test's fakes/structure; the point is: a `fix_patrol` MaintenanceRun is recorded and `patrol.listRuns` no longer exists.)

Run: `node --import tsx --test apps/api/src/features/patrol/service.test.ts`
Expected: FAIL — `maintenanceRuns` not yet written / `patrol.listRuns` removed.

- [ ] **Step 2: Record MaintenanceRun in the service**

In `runFixPatrol`, replace the `ctx.stores.patrol.createRun({...})` call with:

```ts
const run = await ctx.stores.maintenanceRuns.record({
  taskType: "fix_patrol",
  flowId: options.flowId,
  trigger: options.trigger,
  status: "completed",
  summary: `checked ${selected.length}/${universe.length} docs · ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
  details: { universeCount: universe.length, selectedCount: selected.length, selected, findings }
});
return { ok: true, runId: run.id, selectedCount: selected.length, findingCount: findings.length };
```

In `runImprovePatrol`, likewise with `taskType: "improve_patrol"`, summary `checked … · N improve scan(s)`, `details: { universeCount, selectedCount, selected, enqueuedCount }`, return `{ ok: true, runId: run.id, selectedCount: selected.length, enqueuedCount }`.

Update `FixPatrolOutcome`/`ImprovePatrolOutcome` to the shapes in Interfaces. Update `listRuns`/`getRun`:

```ts
export async function listRuns(ctx: AppContext, opts: { taskType?: MaintenanceTaskType; limit: number }): Promise<MaintenanceRun[]> {
  return ctx.stores.maintenanceRuns.list(opts);
}
export async function getRun(ctx: AppContext, id: string): Promise<MaintenanceRun | undefined> {
  return ctx.stores.maintenanceRuns.get(id);
}
```

- [ ] **Step 3: Update routes**

`/run` and `/improve/run` build their JSON from the outcome fields (`outcome.runId`, `outcome.selectedCount`, `outcome.findingCount`/`outcome.enqueuedCount`) — response shape unchanged, so the watcher contract (`fixPatrolOutputSchema`/`improvePatrolOutputSchema`) is unaffected. `/runs` → `patrolService.listRuns(ctx, { limit })` (returns fix+improve runs); `/runs/:id` → `getRun`.

- [ ] **Step 4: Retire PatrolRun**

Remove `PatrolRun` from `packages/core/src/index.ts` (keep `VerifyFinding`). Remove `createRun`/`listRuns`/`getRun`/`PatrolRunInput` from `patrol-store.ts` and `postgres-patrol-store.ts` (+ the run row mapping); keep all cursor code. Drop the corresponding tests in both store test files.

- [ ] **Step 5: Rebuild core, verify**

Run: `npm run build -w @magpie/core` then `node --import tsx --test apps/api/src/features/patrol/service.test.ts apps/api/src/stores/patrol-store.test.ts` then `npm run typecheck`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): patrol records MaintenanceRun; retire PatrolRun"
```

---

### Task 5: Gaps→PR records a run

**Files:**
- Modify: `apps/api/src/scheduling/gap-reconciler.ts` (`reconcileGaps` records a run per tick)
- Modify: `apps/api/src/scheduling/gap-reconciler.test.ts` (assert a run is recorded; failure path records `failed`)

**Interfaces:**
- Consumes: `ctx.stores.maintenanceRuns.record` (Task 2).

- [ ] **Step 1: Add the failing test (RED)**

```ts
test("reconcileGaps records a completed maintenance run", async () => {
  const ctx = makeTestContext();
  await reconcileGaps(ctx, undefined);
  const runs = await ctx.stores.maintenanceRuns.list({ taskType: "process_gaps_to_pull_requests", limit: 10 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "completed");
});
```

Run: `node --import tsx --test apps/api/src/scheduling/gap-reconciler.test.ts`
Expected: FAIL — no run recorded.

- [ ] **Step 2: Record in reconcileGaps**

Wrap the reconcile body so that on success it records `{ taskType: "process_gaps_to_pull_requests", flowId, trigger: "scheduled", status: "completed", summary: \`reconciled flow ${flowId ?? "(default)"}\`, details: {} }`, and on a thrown error records `status: "failed"`, `error: message`, then re-throws. Keep the existing idempotent no-op behaviour (a no-op tick still records a `completed` run so the audit shows it ran).

- [ ] **Step 3: Verify**

Run: `node --import tsx --test apps/api/src/scheduling/gap-reconciler.test.ts` ; `npm run typecheck`
Expected: PASS, exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(api): record a maintenance run per gaps reconcile tick"
```

---

### Task 6: GET /api/maintenance-runs

**Files:**
- Create: `apps/api/src/features/maintenance-runs/routes.ts`
- Modify: `apps/api/src/app.ts` (import + mount at `/maintenance-runs`)
- Modify: `apps/api/src/app.test.ts` (route returns recorded runs)

**Interfaces:**
- Consumes: `ctx.stores.maintenanceRuns.list` (Task 2).

- [ ] **Step 1: Add the failing route test (RED)**

```ts
test("GET /api/maintenance-runs lists recorded runs", async () => {
  const ctx = makeTestContext();
  await ctx.stores.maintenanceRuns.record({ taskType: "fix_patrol", trigger: "scheduled", status: "completed", summary: "s", details: {} });
  const app = buildApp(ctx);
  const res = await app.request("/api/maintenance-runs");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { runs: Array<{ taskType: string }> };
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].taskType, "fix_patrol");
});
```

Run: `node --import tsx --test apps/api/src/app.test.ts`
Expected: FAIL — route not mounted (404).

- [ ] **Step 2: Implement the route**

```ts
import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { parseLimit } from "../../platform/paths.js";
import type { MaintenanceTaskType } from "@magpie/core";

const TASK_TYPES = new Set<MaintenanceTaskType>(["fix_patrol", "improve_patrol", "process_gaps_to_pull_requests"]);

export function maintenanceRunRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 30);
    const rawType = c.req.query("taskType");
    const taskType = rawType && TASK_TYPES.has(rawType as MaintenanceTaskType) ? (rawType as MaintenanceTaskType) : undefined;
    const flowId = c.req.query("flowId")?.trim() || undefined;
    return c.json({ runs: await ctx.stores.maintenanceRuns.list({ taskType, flowId, limit }) });
  });
  return app;
}
```

Mount in `app.ts`: `api.route("/maintenance-runs", maintenanceRunRoutes(ctx));`

- [ ] **Step 3: Verify**

Run: `node --import tsx --test apps/api/src/app.test.ts` ; `npm run typecheck`
Expected: PASS, exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(api): add GET /api/maintenance-runs"
```

---

### Task 7: Schedules page shows recent runs

**Files:**
- Modify: `apps/web/src/lib/types.ts` (add `MaintenanceRun` re-export + `MaintenanceTaskType`)
- Modify: `apps/web/src/components/ConsoleProvider.tsx` (fetch `/maintenance-runs`, expose `maintenanceRuns`)
- Modify: `apps/web/src/components/SchedulesPanel.tsx` (render a "Recent runs" section)
- Modify: `apps/web/src/app/schedules/page.tsx` (pass `maintenanceRuns` to the panel)

**Interfaces:**
- Consumes: `GET /api/maintenance-runs` (Task 6).

- [ ] **Step 1: Re-export the type**

In `lib/types.ts`, add `MaintenanceRun` and `MaintenanceTaskType` to the `@magpie/core` re-export block.

- [ ] **Step 2: Fetch in ConsoleProvider**

Add `const [maintenanceRuns, setMaintenanceRuns] = useState<MaintenanceRun[]>([]);`. Add `apiGet<{ runs: MaintenanceRun[] }>("/maintenance-runs?limit=30", { signal })` to the refresh `Promise.all` (and its destructure + `setMaintenanceRuns(result.runs)`), and include `maintenanceRuns` in the returned context value. Follow the exact positional pattern used by the other fetches.

- [ ] **Step 3: Render in SchedulesPanel**

Add `maintenanceRuns: MaintenanceRun[]` to the panel props. Below the schedules `<section>`, add a "Recent runs" `<section className="crunchSection">` listing each run: `taskType` (humanised), `flowName`, `status` pill, `summary`, `new Date(startedAt).toLocaleString()`. Reuse existing list/row classes. Empty state: "No runs recorded yet."

- [ ] **Step 4: Pass the prop**

In `app/schedules/page.tsx`, pull `maintenanceRuns` from `useConsole()` and pass it to `<SchedulesPanel … maintenanceRuns={maintenanceRuns} />`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck -w @magpie/web`
Expected: exit 0.
Then preview: `preview_start` the `web` server, open `/schedules`, confirm the "Recent runs" section renders (empty state is fine without the API), screenshot.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): show recent maintenance runs on the Schedules page"
```

---

### Task 8: Docs, dead-code, full verification, PR

**Files:**
- Modify: `docs/maintenance-redesign.md` (note the generic run audit under the deferred/Still-open items, and that source-sync's run migrates with Scope B)
- Modify: memory `maintenance-redesign-progress.md` (record project A shipped)

- [ ] **Step 1: Dead-code sweep**

Run: `npm run deadcode`
Expected: exit 0. Fix any orphaned exports left by removing `PatrolRun`/patrol run methods by de-exporting or deleting.

- [ ] **Step 2: Full typecheck (both)**

Run: `npm run typecheck` ; `npm run typecheck -w @magpie/web`
Expected: exit 0 both.

- [ ] **Step 3: Full test gates**

Run: `npm test -w @magpie/jobs` ; `npm test -w @magpie/prompts` ; `node --import tsx --test "apps/api/src/**/*.test.ts"` ; watcher focused tests (`maintenance.test.ts`, `publication.test.ts`, `refresh-pull-requests.test.ts`).
Expected: API green (Postgres tests self-skip); watcher green except the two documented pre-existing failures (Windows path separator; stale `@magpie/git` dist).

- [ ] **Step 4: Update docs + memory, commit**

```bash
git add -A
git commit -m "docs(audit): record the generic maintenance-run audit (project A)"
```

- [ ] **Step 5: Finish + PR**

Use superpowers:finishing-a-development-branch → push `codex/maintenance-run-audit` → open a PR against `main`.

## Self-Review

- **Spec coverage:** Task 1 (type), Task 2–3 (store + table, replace-not-view), Task 4 (patrol write-point + retire `PatrolRun`/`patrol_runs`), Task 5 (gaps write-point), Task 6 (API), Task 7 (Schedules UI), Task 8 (docs + gates). source-sync untouched (spec: migrates at B). `producedProposalIds` correctly absent (spec updated). All spec sections mapped.
- **Type consistency:** `MaintenanceRun`/`MaintenanceTaskType`/`NewMaintenanceRun` (Task 1) used verbatim in Tasks 2–7; store method signatures (`record`/`list`/`get`/`reset`) identical across Tasks 2, 3, 4, 5, 6; outcome shapes defined in Task 4 Interfaces and consumed by the Task 4 routes.
- **Ordering:** core type → store → postgres → consumers (patrol, gaps) → API → UI → verify; every commit compiles (Task 2 stubs the postgres arm until Task 3).
