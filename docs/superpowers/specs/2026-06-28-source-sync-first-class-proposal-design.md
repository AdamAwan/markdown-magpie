# Source-sync as a First-class Proposal (Scope B)

**Status:** Approved  
**Date:** 2026-06-28  
**Author:** Adam

## Goal

Complete Scope B from `docs/maintenance-redesign.md`: make source-sync produce
normal `Proposal` records so it participates in the reconcile gate symmetrically
with gap, verify, dedupe, split, and improve work.

This replaces the remaining source-sync-specific publish path:

- remove `publish_source_sync` as a job type;
- remove the watcher `publish_source_sync` runner branch;
- stop publishing source-sync changesets directly from `SourceSyncRun`;
- publish source-sync changes through `publish_proposal`;
- fold source-sync changes with `fold_changeset_proposal`.

## Background

Scope A already moved source-sync through the gate as a one-way guard. It derives
a constrained changeset from the model plan, then:

- publishes immediately when there is no overlap;
- defers and preserves the changeset when it overlaps an open proposal;
- re-gates deferred runs on later source-sync ticks.

That prevents a source-sync branch from racing an existing proposal, but it keeps
source-sync outside the proposal model. Because source-sync is not a `Proposal`,
the gate cannot fold it into an existing proposal, and other lenses cannot see a
source-sync change as normal in-flight proposal work.

The code already has the right primitives for the full model:

- `Proposal.changeset` represents multi-file proposal work.
- `proposalTargets` and `proposalChangeset` make the gate changeset-aware.
- `fold_changeset_proposal` folds multi-file proposals.
- `publish_proposal` already publishes proposals with a changeset.

Scope B should reuse those primitives rather than introduce a second fold or
publication system.

## Decisions

1. Source-sync plan completion creates a clusterless multi-file `Proposal`.
2. Source-sync publication uses `publish_proposal`; `publish_source_sync` is removed.
3. Source-sync folds through `fold_changeset_proposal`, the same as dedupe and split.
4. `SourceSyncRun` remains only as planning/source detection audit during this increment.
5. Migrating source-sync fully into `MaintenanceRun` is a follow-up once this conversion lands.
6. Empty plans and failed plan jobs keep their current behavior: no proposal is created.

## Architecture

### Current shape

```text
source commit
  -> source_change_sync maintenance job
  -> sync_source_changes_generate_plan AI job
  -> SourceSyncRun with plan + constrained changeset
  -> publish_source_sync github job
  -> source-sync branch
```

### Target shape

```text
source commit
  -> source_change_sync maintenance job
  -> sync_source_changes_generate_plan AI job
  -> SourceSyncRun records planning outcome
  -> Proposal with changeset
  -> reconcile gate
       open-new -> publish_proposal
       fold     -> fold_changeset_proposal
       defer    -> publish_proposal as its own PR
```

The final user-visible artifact is a normal proposal PR. It has the same review,
merge, overlap, publication, and audit behavior as the other maintenance lenses.

## Source-sync Proposal Shape

When `attachSourceSyncPlanFromCompletedJob` receives a valid non-empty plan:

1. Derive the constrained changeset exactly as today.
2. Choose a primary change from the changeset:
   - prefer the first non-delete write;
   - otherwise use the first changeset entry.
3. Create a `Proposal` with:
   - `changeset`: the constrained source-sync changeset;
   - `targetPath`: primary change path;
   - `markdown`: primary change content, or empty string for delete-only edge cases;
   - `flowId`: the run flow;
   - `destinationId`: the run destination;
   - `jobId`: the plan job id for idempotency;
   - `gapSummary`: a concise source-sync summary, not a gap claim;
   - `rationale`: the maintenance plan rationale;
   - `evidence`: an empty array; source file identities live in `draftContext`;
   - `draftContext`: compact source-sync context derived from source id, changed files,
     candidate count, and source name where possible.

The proposal title should be deterministic and readable, for example:

```text
Sync docs to <source name> changes
```

If multiple source repos produce runs in one tick, each changed source still
creates its own proposal. This preserves the existing per-source isolation.

## Reconcile Behavior

Add `reconcileSourceSyncProposal(ctx, proposal)` beside the existing proposal
reconcile helpers in `apps/api/src/scheduling/fold.ts`.

It should match the multi-file proposal model used by dedupe and split:

- Build a `ChangeIntent` with `lens: "source-sync"`.
- Use `proposalTargets(proposal)` for the file-set.
- Compare against `sameFlowOpenProposals(ctx, flowId, proposal.id)`.
- On `fold`, enqueue `fold_changeset_proposal`.
- On `open-new`, enqueue normal proposal publication.
- On `defer`, enqueue normal proposal publication as its own PR, matching the
  existing patrol behavior for non-touchable overlaps.

This deliberately differs from Scope A. Scope A collapsed `fold` and `defer`
into deferred source-sync runs because source-sync had no proposal to fold. Once
source-sync is a proposal, the normal proposal behaviors apply.

## SourceSyncRun Role

`SourceSyncRun` should remain for now as an execution record of source detection
and planning:

- `running`: source change detected and plan job enqueued;
- `skipped`: no candidate docs or empty constrained changeset;
- `failed`: plan job failed terminally;
- `completed`: plan produced a proposal;
- keep traceability through the shared plan `jobId`.

It should stop owning publication state. These become obsolete in the target
runtime:

- `published` status;
- run-level `publication`;
- `recordRunPublication`;
- source-sync execution context for publishing;
- deferred run re-gate.

Deferred source-sync runs should not be part of the new steady state. Reconcile
deferral lives on the proposal path.

## Job Catalog and Watcher Changes

Remove `publish_source_sync` from:

- `packages/jobs/src/types.ts`;
- `packages/jobs/src/catalog.ts`;
- `packages/jobs/src/schemas.ts`;
- `packages/jobs` tests;
- watcher publication runner support;
- watcher publication tests;
- API job completion dispatch.

Keep:

- `sync_source_changes_generate_plan`;
- `source_change_sync`;
- `publish_proposal`;
- `fold_changeset_proposal`.

The watcher should publish source-sync proposals through its existing
`publish_proposal` path. That path already supports changesets.

## API and Routes

Remove or repurpose endpoints used only for direct source-sync publication:

- Remove `GET /api/source-sync/runs/:id/execution-context`; it exists only for
  `publish_source_sync`.
- Keep `GET /api/source-sync/runs/:id` and the list endpoint as source-sync
  planning history.

The main source-sync trigger endpoint remains:

- `POST /api/source-sync/run`

Its response can continue returning `runIds`. The created proposals are a
downstream result of completed plan jobs, not immediate trigger output.

## Data Migration

No migration is needed to create the new proposal behavior because proposals
already have a `changeset` column.

Potential cleanup migrations can be deferred until after the code path is
stable:

- drop `source_sync_runs.publication` if it exists;
- remove source-sync run statuses that are no longer emitted;

Do not add `proposal_id` to `source_sync_runs` in this increment. Keep
traceability through `Proposal.jobId` and the source-sync run's `jobId`; both
refer to the same plan job.

## Idempotency

The completion handler must be idempotent:

- If a proposal already exists for the plan job id, reuse it and do not create a
  duplicate proposal.
- If the run is no longer `running`, do not regress it.
- If the proposal was already reconciled or published, do not enqueue duplicate
  fold/publish work.

The existing proposal store already supports `getByJobId`; source-sync should use
the same job-id idempotency pattern as other completion handlers.

## Failure Behavior

Unchanged:

- malformed plan output fails the run;
- empty constrained changeset marks the run skipped;
- terminal plan-job failure marks the run failed;
- the source baseline is not rewound.

Changed:

- publication failure now belongs to the proposal publication job and proposal
  status, not to `SourceSyncRun`.

## Documentation and UI Alignment

Update docs and dataflow language after the conversion:

- `docs/scheduled-jobs-migration-status.md`;
- `docs/maintenance-redesign.md`;
- `docs/api.md`;
- `docs/ai-jobs.md`;
- `apps/web/src/components/dataflow/flows.ts`;
- `apps/web/src/components/dataflow/flows.test.tsx`.

The dataflow graph currently describes the post-Scope-B state. After this work,
that should become true rather than aspirational.

## Testing Strategy

Focused tests should cover:

- Completing a source-sync plan creates a proposal with a constrained changeset.
- The created proposal uses the source-sync run's flow and destination.
- No `publish_source_sync` job is created.
- A clear source-sync proposal enqueues normal proposal publication.
- A source-sync proposal overlapping a touchable proposal enqueues
  `fold_changeset_proposal`.
- A source-sync proposal overlapping an approved/non-touchable proposal
  self-publishes through the proposal outbox.
- Empty plans still mark the run skipped and create no proposal.
- Terminal plan-job failure still marks the run failed and does not rewind the
  source baseline.
- `packages/jobs` no longer exposes `publish_source_sync`.
- The watcher publication runner no longer supports `publish_source_sync`.
- Existing proposal changeset publication tests continue to cover the actual git
  publishing path.

Suggested verification commands:

```bash
npm test -w @magpie/jobs
node --import tsx --test "apps/api/src/features/source-sync/**/*.test.ts" "apps/api/src/features/jobs/**/*.test.ts" "apps/api/src/scheduling/**/*.test.ts"
node --import tsx --test "apps/watcher/src/**/*.test.ts"
npm run typecheck
npm run deadcode
```

## Out of Scope

- Replacing `SourceSyncRun` with `MaintenanceRun` completely.
- Adding a new generic persisted `ChangeIntent` table.
- Changing how source commits are detected or baselined.
- Changing the source-sync model prompt.
- Changing human review policy.

## Open Questions

No blocking product questions remain.

No blocking product questions remain. This spec intentionally avoids a
`source_sync_runs.proposal_id` migration; run-to-proposal traceability uses the
existing shared plan `jobId`.
