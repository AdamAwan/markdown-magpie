# Generic Maintenance-Run Audit — Design

**Date:** 2026-06-26
**Status:** Approved
**Relationship:** Project **A** — the enabler for the deferred source-sync "Scope B"
(make source-sync a first-class Proposal). A lands first; B finishes the storage
unification by migrating source-sync onto this audit.

## Goal

Give every scheduled maintenance task one shared, durable, queryable run-history
record, surfaced in the console. Today the producers are inconsistent:
`SourceSyncRun` and `PatrolRun` are two separate bespoke implementations of the
same idea, gaps→PR records nothing, and none of them are shown in the UI. Replace
the bespoke records with one generic `MaintenanceRun`.

## Framing: a run is an execution audit

A `MaintenanceRun` records **one scheduled-task execution** — when it ran, which
flow, what it scanned, what it produced, and the outcome. It is **not** a tracker
for the downstream proposal's fate (published / merged / deferred); that lifecycle
lives on the `Proposal`. Today `SourceSyncRun` conflates the two — splitting them
is cleaner and is exactly what lets source-sync become a plain Proposal in B.

## Scope and sequencing (A vs B)

- **A (this spec):** introduce `MaintenanceRun` + store + table; migrate the pure
  execution-log producers onto it — **fix-patrol, improve-patrol** (replacing
  `PatrolRun`) and **gaps→PR** (a record it never had); surface run history on the
  Schedules page. Retire `PatrolRun` and `patrol_runs`.
- **B (later):** `source_change_sync` keeps its bespoke `SourceSyncRun` through A,
  because that record also holds the changeset, the deferred re-gate state, and the
  publication — all of which only move off it when B turns source-sync into a
  Proposal. At B, source-sync sheds those onto the Proposal and begins writing a
  `MaintenanceRun` like the others; `SourceSyncRun`/`source_sync_runs` retire then.

Source-sync is intentionally the last to migrate — not because it is special, but
because its run is entangled with the lifecycle B untangles.

## Decisions (settled in brainstorming)

1. **Do A before B.**
2. **Unify storage** — one generic table that *replaces* the bespoke records
   (not a read-only view over the existing typed tables). Dropping the old tables'
   data is acceptable: there is no production data yet.
3. **Schema shape** — a few typed columns for the list/filter view plus a single
   `details` JSONB blob for the task-specific payload (chosen over more structured
   per-task count columns, which would re-introduce per-task coupling).
4. **Run history surfaces on the Schedules page** (where Crunch's run cards used to
   live), not a new top-level section.

## Data model

New core type:

```
MaintenanceRun {
  id: string;                       // uuid
  taskType: MaintenanceTaskType;    // "fix_patrol" | "improve_patrol" | "process_gaps_to_pull_requests"
                                    //   (B adds "source_change_sync")
  flowId?: string;
  trigger: "scheduled" | "manual";
  status: "running" | "completed" | "failed";
  summary: string;                  // one-line human text, e.g. "checked 5 docs · 1 finding"
  error?: string;
  details: MaintenanceRunDetails;   // JSONB; task-specific (see below)
  producedProposalIds: string[];    // proposals this run created (audit: which PRs came from this tick)
  startedAt: string;
  completedAt?: string;
}
```

- `status` carries `running` for future async tasks (source-sync at B). The A
  tasks run synchronously inside the API tick, so they write a terminal
  `completed`/`failed` row in one shot; `running` + a start/complete store API are
  added in B when needed (not built speculatively now).
- `details` is an open JSONB object. Per task: fix-patrol →
  `{ universeCount, selectedCount, selected: string[], findings: VerifyFinding[] }`;
  improve-patrol → `{ universeCount, selectedCount, selected: string[], enqueuedCount }`;
  gaps→PR → `{ drafted, published }` (best available; counts may be approximate
  until the reconcile endpoint exposes real ones — see Known limitations).

Postgres table `maintenance_runs`: typed columns (`id`, `task_type`, `flow_id`,
`trigger`, `status`, `summary`, `error`, `produced_proposal_ids text[]`,
`started_at`, `completed_at`) + `details jsonb`. Index on `(task_type, started_at DESC)`
and `(flow_id, started_at DESC)`.

## Store

`MaintenanceRunStore` (in-memory + Postgres), wired like the other stores
(`createMaintenanceRunStore` factory, `platform/stores.ts` permission entry,
`context.ts` + `test-support/context.ts` wiring):

- `record(input): Promise<MaintenanceRun>` — writes a terminal (`completed`/`failed`)
  row atomically. The only writer A needs.
- `list(filters: { taskType?; flowId?; limit }): Promise<MaintenanceRun[]>` —
  newest first.
- `get(id): Promise<MaintenanceRun | undefined>`.
- `reset()` — for the config reset path, like the other stores.

(`start`/`complete`/`fail` for the async `running` lifecycle are deferred to B.)

## Write-points

- **`apps/api/src/features/patrol/service.ts`** — `runFixPatrol` / `runImprovePatrol`
  call `ctx.stores.maintenanceRuns.record(...)` instead of
  `ctx.stores.patrol.createRun(...)`, building `summary` + `details` and listing the
  proposal ids they enqueued. The patrol store keeps the **cursor** (`stampChecked`,
  cursor reads) and loses its run methods (`createRun`, `listRuns`).
- **`apps/api/src/scheduling/gap-reconciler.ts`** — `reconcileGaps` records a run per
  tick (`completed`, or `failed` on throw) with the counts it has.
- **source-sync** — untouched in A.

## API and UI

- **API:** `GET /api/maintenance-runs?taskType=&flowId=&limit=` returns the list.
  The existing `GET /api/patrol/runs` is repointed to read from the maintenance-run
  store (filtered to the patrol task types) or removed in favour of the new route —
  decided in the plan; nothing in the web app consumes `/patrol/runs` today.
- **Web:** the Schedules page (`SchedulesPanel`) gains a "Recent runs" section below
  the schedules table — grouped/filterable by task, each row expandable into its
  `details`. `ConsoleProvider` fetches `/maintenance-runs` alongside the existing
  scheduled-task fetch; reuse the run-card styling that survived from Crunch.

## What gets retired in A

- Core `PatrolRun` type and the patrol store's run methods.
- `patrol_runs` table and its `findings` column — dropped by the new migration
  (`0032_maintenance_runs.sql` creates `maintenance_runs` and drops `patrol_runs`).
  Data loss is acceptable (no production data).
- `VerifyFinding` stays in core (now carried inside `MaintenanceRun.details`).

## Known limitations (carried, not fixed here)

- gaps→PR run counts are only as good as what `reconcileGaps` exposes today
  (it returns zeros via a standing TODO). The run records what is available; richer
  counts are a follow-up when the reconcile path surfaces them.
- No retention/auto-prune in A — the list endpoint caps results (e.g. latest 20–50
  per task). Pruning is a later concern.

## Testing strategy (inline TDD, RED first)

- Store: `record` then `list`/`get`, filtering by `taskType`/`flowId`, newest-first
  ordering (in-memory; Postgres store test self-skips without `DATABASE_URL`).
- Patrol service: a fix-patrol tick writes one `MaintenanceRun` with the expected
  `taskType`, `summary`, and `details.findings`; improve-patrol likewise; assert no
  `PatrolRun` is written.
- Gap reconciler: a tick writes a `completed` run; a thrown reconcile writes `failed`.
- Route: `GET /api/maintenance-runs` returns recorded runs and honours filters.
- Web: typecheck; the Schedules page renders a runs section (verified in preview).

**Pre-PR gates:** `npm test -w @magpie/jobs`/`-w @magpie/prompts` (unaffected but
run), full API suite, watcher focused tests, `npm run typecheck`,
`npm run typecheck -w @magpie/web`, `npm run deadcode`.
