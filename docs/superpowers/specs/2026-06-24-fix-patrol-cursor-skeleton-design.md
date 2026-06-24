# Fix-patrol cursor skeleton — design

**Status:** Approved · **Date:** 2026-06-24 · **Author:** Adam (with Claude)

Part of the KB-maintenance redesign ([docs/maintenance-redesign.md](../../maintenance-redesign.md)),
migration **step 4 — build fix-patrol**. This increment builds *only the rolling-cursor
skeleton*: the mechanism that, each tick, picks the least-recently-checked KB documents in a
flow and records that they were visited. The three fix lenses (verify / dedupe / split) that
will actually inspect those files and emit `ChangeIntent`s are **out of scope** and land as
later increments on this same harness.

## 1. Goal & shape

fix-patrol is a **patrol** producer (nothing changed in the world; the KB rots on its own).
It mirrors **source-sync** exactly: a scheduled `maintenance` job, run by the watcher's
`MaintenanceRunner` POSTing a thin API endpoint, with all store access and orchestration in
the API. The skeleton's per-tick work is:

> resolve the flow's document universe → select a batch (oldest-N + a random sample) →
> *(no-op: the lens slot)* → stamp those docs as checked → record a patrol run.

Because there is no lens yet, a tick produces no proposals or PRs — it only advances the
cursor and writes a visible run record.

## 2. Components

A new `patrol` feature, sibling to `source-sync`:

| File | Responsibility |
| --- | --- |
| `apps/api/src/scheduling/patrol-cursor.ts` | **Pure** `selectPatrolBatch()` — the selection algorithm, no I/O. |
| `apps/api/src/stores/patrol-store.ts` | `PatrolStore` interface + `InMemoryPatrolStore`. Holds **both** the cursor and the run history (like `SourceSyncStore`). |
| `apps/api/src/stores/postgres-patrol-store.ts` | Postgres `PatrolStore`. |
| `apps/api/src/features/patrol/service.ts` | `runFixPatrol(ctx, { flowId, trigger })` — the per-tick orchestration; the no-op lens slot is a marked comment here. |
| `apps/api/src/features/patrol/routes.ts` | `POST /api/fix-patrol/run`, `GET /api/fix-patrol/runs`. |
| `packages/jobs/src/{types,schemas,catalog}.ts` | New `fix_patrol` job type (maintenance capability) + input/output schemas. |
| `apps/watcher/src/runners/maintenance.ts`, `http-client.ts` | Register `fix_patrol`; `runFixPatrol` POSTs `/api/fix-patrol/run`. |
| `apps/api/src/scheduling/task-registry.ts` | New `fix-patrol` flow-task template. |
| `packages/db/migrations/0027_fix_patrol.sql` | The two tables. |
| `context.ts`, Postgres platform wiring, `reset-stores` | Store registration. |

## 3. Data model

Two tables, mirroring the source-sync convention (`flow_id` NOT NULL default `''` so the
default flow dedupes to one cursor row per doc; runs allow NULL flow_id like
`source_sync_runs`).

```sql
CREATE TABLE patrol_cursor (
  flow_id         text        NOT NULL DEFAULT '',
  doc_path        text        NOT NULL,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, doc_path)
);

CREATE TABLE patrol_runs (
  id              uuid        PRIMARY KEY,
  flow_id         text,
  trigger         text        NOT NULL,        -- 'scheduled' | 'manual'
  universe_count  integer     NOT NULL,
  selected_count  integer     NOT NULL,
  selected        jsonb       NOT NULL,        -- string[] of doc paths
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

A document with **no cursor row** = never checked = highest selection priority. The cursor is
its own table (not derived from run history) so it survives history pruning and is a cheap
point read.

### `PatrolStore` interface

```ts
export interface PatrolRunInput {
  flowId?: string;
  trigger: "scheduled" | "manual";
  universeCount: number;
  selectedCount: number;
  selected: string[];
}

export interface PatrolStore {
  // The cursor: when each doc in a flow was last checked. Default flow = undefined.
  listCursor(flowId: string | undefined): Promise<Array<{ docPath: string; lastCheckedAt: string }>>;
  // Upsert last_checked_at = now() for each selected doc (one batch).
  stampChecked(flowId: string | undefined, docPaths: string[]): Promise<void>;
  createRun(input: PatrolRunInput): Promise<PatrolRun>;
  listRuns(limit: number): Promise<PatrolRun[]>;
  getRun(id: string): Promise<PatrolRun | undefined>;
  reset(): Promise<void>;
}
```

`PatrolRun` (the @magpie/core view) carries `id, flowId?, trigger, universeCount,
selectedCount, selected, createdAt`.

## 4. Selection algorithm

```ts
export function selectPatrolBatch(
  universe: string[],
  checkedAt: Map<string, string>,            // docPath -> ISO lastCheckedAt
  opts: { batchSize: number; randomCount: number; rng?: () => number }
): string[];
```

Pure and deterministic given `rng` (defaults to `Math.random`):

1. Sort `universe` by `lastCheckedAt` ascending, **never-checked first** (absent = epoch),
   tiebreak by path ascending.
2. Take the front `batchSize - randomCount` → the **exploit** share (most stale).
3. From the *remainder*, take up to `randomCount` via `rng` → the **explore** share, so
   nothing starves and load never synchronises into waves.
4. Union, dedup, cap at `batchSize`. If `universe.length <= batchSize`, return all of it.

This is the "oldest-N + random sample" from the redesign's Decisions section. `rng` is
injected so tests are deterministic.

## 5. Per-tick orchestration — `runFixPatrol`

```ts
runFixPatrol(ctx, { flowId, trigger }): Promise<{ runId: string; selectedCount: number; universeCount: number }>
```

1. Resolve the flow's destination repository id(s) — the same flow→repo scoping the retrieve
   service uses (`flow.destinationId ? [id] : undefined`; undefined = unscoped). An unknown
   flow id is a 400-class `unknown_flow`, like retrieve.
2. `universe` = `ctx.stores.knowledgeIndex.listDocuments()` filtered to those repository ids
   → the list of `doc.path`.
3. `checkedAt` = map built from `store.listCursor(flowId)`.
4. `selected = selectPatrolBatch(universe, checkedAt, { batchSize, randomCount })`.
5. **No-op lens slot** — a marked comment: *"future increments run verify/dedupe/split over
   `selected` here and emit ChangeIntents through the reconcile gate."*
6. `await store.stampChecked(flowId, selected)`.
7. `run = await store.createRun({ flowId, trigger, universeCount, selectedCount, selected })`.
8. Return `{ runId: run.id, selectedCount, universeCount }`.

Empty universe (flow not indexed yet) is a valid no-op: zero selected, a run is still
recorded so the patrol is observable.

## 6. Execution path & scheduling

- **Job:** `fix_patrol`, capability `maintenance`, input `{ flowId?: string }`, output
  `{ runId: string; selectedCount: number }`. Queue named by type (no provider partition),
  exactly like `source_change_sync`.
- **Watcher:** add `fix_patrol` to `MAINTENANCE_JOB_TYPES`; a `runFixPatrol(job)` method reads
  `flowId` defensively and calls `this.api.runFixPatrol(flowId, signal)`, returning the parsed
  output. `WatcherApi.runFixPatrol` POSTs `/api/fix-patrol/run`.
- **Route:** `POST /api/fix-patrol/run` accepts `{ flowId? }`, runs `runFixPatrol` with
  `trigger: "scheduled"` (the scheduled/watcher path) — the skeleton has no separate manual
  UI trigger, but the `trigger` column exists for when one is added. `GET /api/fix-patrol/runs`
  lists recent runs for visibility.
- **Schedule:** a new `fix-patrol` template in the task registry, expanded per flow like the
  others, jobType `fix_patrol`, `input: (flowId) => ({ flowId })`.

## 7. Tunable defaults (chosen here; easy to change later)

| Knob | Default | Rationale |
| --- | --- | --- |
| `batchSize` (N per tick) | **10** | Bounded cost per tick; rotates a modest KB over days. |
| `randomCount` (explore share) | **2** | ≈ the 80/20 oldest/random split the doc floated. |
| `defaultCron` | **`0 * * * *`** (hourly) | Patrol is slower than event jobs; disabled until enabled in the UI, like every task. |

Defined as named constants in `features/patrol/service.ts`. The redesign leaves the exact
split and a staleness threshold open "until real volume" — the skeleton uses plain oldest-N +
random and no threshold (YAGNI).

## 8. Testing

- `patrol-cursor.test.ts` — selection: never-checked first; oldest-first ordering; path
  tiebreak; deterministic random sample via a seeded `rng`; universe smaller than batch
  returns all; random share drawn only from the non-exploit remainder.
- `patrol-store.test.ts` (in-memory) — `stampChecked` upserts `lastCheckedAt`; `listCursor`
  scopes by flow and isolates the default flow; `createRun`/`listRuns` newest-first;
  `getRun`; `reset` clears both.
- `patrol/service.test.ts` — `runFixPatrol` selects within the flow's repo scope, stamps the
  selected docs, records a run with correct counts; a second tick rotates to different docs;
  unknown flow → `unknown_flow`; empty universe records a zero-selected run.
- `catalog.test.ts` — `fix_patrol` registered, `maintenance` capability, queue named by type.
- `maintenance.test.ts` — the runner handles `fix_patrol` and calls `api.runFixPatrol`.
- Postgres store test — present but `# SKIP` without `DATABASE_URL`, like the other PG stores.

## 9. Out of scope (explicit)

- The **verify / dedupe / split lenses** themselves and any `ChangeIntent` emission or gate
  routing — later increments.
- Any **web UI** panel for patrol runs (the API + store land here; a console panel is a
  separate increment). The run history is reachable via `GET /api/fix-patrol/runs`.
- **Staleness-threshold** selection and **cursor-row pruning** for vanished docs (a stale
  cursor row is simply never selected because it is not in the current universe).
- `improve-patrol` (step 5) and retiring `trigger_scheduled_crunch` (step 6).

## Global constraints

- knip runs **strict** (no in-file-only export leniency): export only what is consumed
  cross-file; keep helper types/consts file-local otherwise.
- In-memory and Postgres `PatrolStore` impls must stay behaviourally identical (parity tests).
- Local imports use the `.js` suffix; `@magpie/*` imports do not.
- UK English in any user-facing copy (task label/description).
