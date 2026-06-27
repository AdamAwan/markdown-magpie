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
- `refresh_pull_requests`
- `fix_patrol`
- `improve_patrol`

These are flow-scoped scheduled tasks, surfaced in the Schedules UI and executed
through the watcher/job system.

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

### 1. Scope B: make source-sync a first-class Proposal

This is the main remaining product follow-up.

Current behavior:

- source-sync goes through the gate
- on overlap, it defers and preserves its changeset
- it does not yet fold symmetrically like the other proposal-producing flows

Evidence:

- `docs/maintenance-redesign.md`
- `apps/api/src/features/source-sync/service.ts`

Concrete gap:

- source-sync still collapses `fold` into `defer` because it is not yet modeled
  as a first-class Proposal with the same fold path as the other lenses

Why it matters:

- the redesign goal is a symmetric gate where source-sync can fold/open/defer the
  same way other maintenance intents do

### 2. Migrate source-sync into the generic maintenance-run audit

Current behavior:

- fix-patrol, improve-patrol, and gaps→PR record `MaintenanceRun`
- source-sync still has its own `SourceSyncRun` lifecycle because it carries
  changeset/defer/publication state

Evidence:

- `docs/maintenance-redesign.md`
- `packages/db/migrations/0032_maintenance_runs.sql`
- `apps/api/src/features/maintenance-runs/routes.ts`

This is coupled to Scope B. Once source-sync becomes a first-class Proposal, its
special run lifecycle can likely be reduced enough to join the generic audit.

### 3. Clean up stale docs that still describe retired crunch behavior

These are the clearest documentation drifts:

- `docs/api.md`
- `docs/ai-jobs.md`

Examples:

- `docs/api.md` still lists `crunch_knowledge_base` as an active job type in the
  Jobs section.
- `docs/ai-jobs.md` still documents `/api/crunch/*`, `crunch_runs`,
  `crunch_settings`, and `trigger_scheduled_crunch`.

This is not a runtime blocker, but it will mislead anyone using the docs as the
current contract.

### 4. Align the dataflow docs/UI narrative with backend reality

There is at least one current mismatch:

- `apps/web/src/components/dataflow/flows.ts`
- `apps/web/src/components/dataflow/flows.test.tsx`

The dataflow graph/test language presents the post-Scope-B symmetric outcome as
already done, while backend comments in source-sync still describe Scope B as a
future step.

That should be reconciled one way or the other:

- either implement Scope B
- or adjust the graph/tests/comments so they all describe the same current state

## Recommended next steps

1. Implement Scope B for source-sync first.
2. Fold source-sync into the generic maintenance-run audit as part of that work,
   or immediately after it.
3. Update `docs/api.md` and `docs/ai-jobs.md` to remove retired crunch behavior.
4. Reconcile the dataflow graph/test copy with the actual backend state.

## Practical checklist

- [x] Replace in-process scheduled execution with pg-boss-backed schedules
- [x] Move active scheduled work to the task-registry + watcher model
- [x] Retire scheduled crunch runtime paths
- [x] Remove `/api/crunch` from the app
- [x] Add forward migration dropping crunch tables
- [ ] Make source-sync a first-class Proposal with symmetric gate behavior
- [ ] Migrate source-sync off its bespoke run lifecycle into generic maintenance audit
- [ ] Remove stale crunch references from public docs
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
