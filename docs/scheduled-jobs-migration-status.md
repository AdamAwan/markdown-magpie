# Scheduled Jobs Migration Status

_Last updated: 2026-06-27_

## Current state

The migration from the old in-process / crunch-oriented scheduled jobs to the new
pg-boss-backed scheduled jobs is effectively complete.

What is now live in the repo:

- Scheduled work is reconciled into pg-boss schedules rather than in-process
  schedulers.
- The active scheduled task model is per-flow and queue-backed.
- The old scheduled crunch flow has been retired from runtime code.
- The old `/api/crunch` route is gone.
- The old crunch tables have a forward drop migration.

## What shipped

### 1. pg-boss is the runtime scheduler / broker

- `apps/api/src/jobs/schedule-reconciler.ts`
- `apps/api/src/features/jobs/routes.ts`
- `packages/jobs/src/catalog.ts`

The API exposes `/api/jobs` and `/api/jobs/schedules`, and schedule settings are
reconciled into pg-boss rather than being driven by local polling loops.

### 2. The surviving scheduled jobs are the new task set

- `apps/api/src/scheduling/task-registry.ts`
- `apps/watcher/src/runners/maintenance.ts`
- `apps/web/src/components/SchedulesPanel.tsx`

The scheduled task inventory is now:

- `process_gaps_to_pull_requests`
- `source_change_sync`
- `refresh_flow_snapshot` (renamed from `refresh_pull_requests`)
- `correctness_patrol` (renamed from `fix_patrol`)
- `editorial_patrol` (renamed from `improve_patrol`)

These are flow-scoped scheduled tasks, surfaced in the Schedules UI and executed
through the watcher/job system. The last three were renamed for clarity (migration
`0033_rename_patrol_task_types.sql` forward-migrates historical
`maintenance_runs.task_type` rows; the old pg-boss schedules are torn down
automatically by `reconcileSchedules` at startup). The `baseKey`s, REST routes
(`/api/fix-patrol/*`), and service methods are unchanged.

### 3. Scheduled crunch is retired

- `apps/api/src/app.ts`
- `packages/jobs/src/catalog.ts`
- `packages/db/migrations/0031_drop_crunch.sql`
- `apps/api/src/app.test.ts`

The repo no longer mounts `/api/crunch`, no longer defines the old crunch job
types in the active catalog, and includes a forward migration dropping
`crunch_runs` and `crunch_settings`.

### 4. The redesign doc marks the migration as shipped

- `docs/maintenance-redesign.md`

Section 8 says all six migration steps are shipped, including retirement of
`trigger_scheduled_crunch` and the `crunch_*` job types.

## What is left to do

### 1. ~~Scope B: make source-sync a first-class Proposal~~ (shipped)

Source-sync plan completion now creates a `Proposal` with a multi-file changeset
and routes it through `reconcileSourceSyncProposal`, which folds or publishes
symmetrically with the other proposal-producing lenses. `publish_source_sync` and
the direct execution-context path are retired.

### 2. Migrate source-sync into the generic maintenance-run audit

Current behavior:

- fix-patrol, improve-patrol, and gaps→PR record `MaintenanceRun`
- source-sync still has its own `SourceSyncRun` lifecycle

Evidence:

- `docs/maintenance-redesign.md`
- `packages/db/migrations/0032_maintenance_runs.sql`
- `apps/api/src/features/maintenance-runs/routes.ts`

Now that Scope B is shipped and the deferred/publication lifecycle is removed,
migrating `SourceSyncRun` to the generic audit is a straightforward follow-up.

### 3. Clean up stale docs that still describe retired crunch behavior — done

`docs/api.md` no longer lists `crunch_knowledge_base`, and `docs/ai-jobs.md` no
longer documents the `/api/crunch/*` endpoints, `crunch_runs`/`crunch_settings`,
the Crunch section, or `trigger_scheduled_crunch`. The public docs now match the
current contract. (The `docs/maintenance-redesign.md` design doc still references
crunch by design — it explains why crunch was retired.)

## Recommended next steps

1. Migrate source-sync into the generic `MaintenanceRun` audit.

## Practical checklist

- [x] Replace in-process scheduled execution with pg-boss-backed schedules
- [x] Move active scheduled work to the task-registry + watcher model
- [x] Retire scheduled crunch runtime paths
- [x] Remove `/api/crunch` from the app
- [x] Add forward migration dropping crunch tables
- [ ] Make source-sync a first-class Proposal with symmetric gate behavior
- [ ] Migrate source-sync off its bespoke run lifecycle into generic maintenance audit
- [x] Remove stale crunch references from public docs
- [ ] Align dataflow narrative with actual backend behavior

## Reference files

- `docs/maintenance-redesign.md`
- `apps/api/src/jobs/schedule-reconciler.ts`
- `apps/api/src/scheduling/task-registry.ts`
- `apps/watcher/src/runners/maintenance.ts`
- `packages/jobs/src/catalog.ts`
- `apps/api/src/app.ts`
- `apps/api/src/app.test.ts`
- `apps/api/src/features/source-sync/service.ts`
- `apps/api/src/features/maintenance-runs/routes.ts`
- `packages/db/migrations/0031_drop_crunch.sql`
- `packages/db/migrations/0032_maintenance_runs.sql`
- `docs/api.md`
- `docs/ai-jobs.md`
