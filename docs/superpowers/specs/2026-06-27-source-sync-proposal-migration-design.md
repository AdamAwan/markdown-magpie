# Source-Sync Proposal Migration — Design

**Date:** 2026-06-27
**Status:** Approved
**Relationship:** Maintenance redesign Scope B. Project A shipped the generic
`MaintenanceRun` audit; this project migrates source-sync onto that audit and
turns source-sync changes into first-class proposals.

## Goal

Remove the bespoke source-sync run lifecycle and make source-sync behave like the
other maintenance lenses:

- every source-sync execution is recorded in the generic `MaintenanceRun` audit;
- every non-empty source-sync document change becomes a normal `Proposal`;
- publication and overlap handling use the existing proposal gate, fold, and PR
  machinery;
- the old `SourceSyncRun`, `source_sync_runs`, run routes, and `publish_source_sync`
  path are removed.

This is a hard migration. Old source-sync run history does not need to be
preserved.

## Ownership Model

The old `SourceSyncRun` mixed three responsibilities. Scope B splits them:

- **`MaintenanceRun`** records that the scheduled/manual source-sync task ran:
  flow, source, commit range, counts, status, summary, error, and proposal ids.
- **`Proposal`** owns the document change and its downstream lifecycle:
  draft, fold, branch, PR, review, merge, rejection, and supersession.
- **Source-sync state** keeps only baseline progress:
  the last processed SHA per `(flowId, sourceId)` so the next tick knows what
  changed.

The surviving source-sync store is therefore state-only. It may keep the current
store name if that is the smallest change, but it must not expose run-history
methods.

## Source-Sync Flow

`source_change_sync` keeps the current front half:

1. Resolve the selected flow, destination, and configured git sources.
2. For each git source, compare the stored last SHA to current HEAD.
3. Diff changed files in the watched subpath.
4. Retrieve up to the existing candidate-document limit.
5. Enqueue `sync_source_changes_generate_plan` for sources with candidate docs.

Baseline state still advances when a source change has been accepted for
processing, matching the current non-retry behaviour. The source change is not
lost because the completion path records an audit row and, for non-empty changes,
a proposal.

On `sync_source_changes_generate_plan` completion:

- malformed output records a failed `MaintenanceRun`;
- an empty constrained changeset records a completed `MaintenanceRun` with no
  proposal;
- a non-empty constrained changeset creates exactly one draft `Proposal`;
- that proposal runs through the existing multi-file gate/publication path:
  `fold_changeset_proposal` for touchable overlaps, otherwise `publish_proposal`.

`publish_source_sync` is removed. Source-sync no longer publishes branches
directly and no longer has a separate no-PR publication path.

## Proposal Shape

One source commit/source tick creates one multi-file proposal when there is a
non-empty constrained changeset.

The proposal uses the existing changeset proposal model:

- `title`: `Source sync: <source name> <fromSha>..<toSha>`;
- `targetPath`: the first write in the constrained changeset;
- `markdown`: the content of that first write;
- `changeset`: the full constrained file-set;
- `flowId`: the source-sync flow id;
- `destinationId`: the resolved destination id;
- `rationale`: the generated plan rationale plus source commit context;
- `draftContext`: enough compact context for review, including changed source
  files and candidate counts.

The first-write primary document is deliberately simple and deterministic. The
full file-set remains authoritative through `changeset`.

## Reconcile Gate and Publication

Source-sync becomes a first-class participant in the same flow-scoped gate as the
other lenses.

For the source-sync proposal:

- build a `ChangeIntent` with lens `source-sync` and targets from the proposal
  changeset;
- compare only against same-flow open proposals;
- on `fold`, enqueue `fold_changeset_proposal`;
- on `open-new` or `defer`, enqueue publication through the existing proposal
  outbox (`publish_proposal`).

This matches the current dedupe/split ownership model: the proposal owns
publication, and the gate only decides whether to fold first. Approved or
otherwise non-touchable overlaps are still surfaced by the broader PR overlap
backstops; source-sync does not reintroduce its old deferred-run queue.

## MaintenanceRun Audit

`MaintenanceTaskType` gains `"source_change_sync"`.

Each source-sync task execution records audit rows in `MaintenanceRun`. Because
one scheduled tick can inspect multiple git sources, record one run per source
that had work to consider. The run details are open JSON and include:

- `sourceId`, `sourceName`;
- `destinationId`;
- `fromSha`, `toSha`;
- `changedFileCount`;
- `candidateCount`;
- `proposalIds`;
- `jobId` for the plan job when applicable.

Expected audit outcomes:

- no configured git sources or no changed commits: no source-specific run is
  required, but the job output reports zero work;
- changed commits with no watched-path changes: no proposal and no source-specific
  run is required;
- changed commits with no candidate docs: completed run, no proposal;
- empty constrained changeset: completed run, no proposal;
- non-empty constrained changeset: completed run with created proposal id;
- gather/planning/completion failure: failed run where a source-specific run can
  be attributed.

The `source_change_sync` job output changes from `{ runIds }` to
`{ maintenanceRunIds, proposalIds }`.

## API and UI

API:

- keep `POST /api/source-sync/run` as the manual/scheduled trigger;
- change its response to report maintenance run ids and proposal ids;
- remove `GET /api/source-sync/runs`;
- remove `GET /api/source-sync/runs/:id`;
- remove `GET /api/source-sync/runs/:id/execution-context`;
- continue using `/api/maintenance-runs` for run history;
- continue using `/api/proposals` for generated changes.

UI:

- Schedules page shows source-sync executions in Recent runs via
  `/api/maintenance-runs`;
- Proposals page shows source-sync changes as normal proposals;
- if the proposal preview does not make a multi-file changeset clear enough, add
  a small changed-files summary there as part of this work;
- remove any source-sync-run-specific UI assumptions.

## Jobs and Watcher

Keep:

- `source_change_sync`;
- `sync_source_changes_generate_plan`;
- `fold_changeset_proposal`;
- `publish_proposal`.

Remove:

- `publish_source_sync` job type and schemas;
- watcher `PublicationRunner.publishSourceSync`;
- API source-sync publication execution-context endpoint;
- source-sync publication completion handler;
- any tests and docs that describe source-sync branch-only publication.

The completion dispatcher creates the source-sync proposal and routes it through
the same fold/publication helpers as other changeset proposals.

## Data Migration

Add a migration that:

- drops `source_sync_runs`;
- keeps or creates a slim state table for `(flow_id, source_id, last_sha,
  last_checked_at)`;
- leaves `maintenance_runs` as the only run-history table for source-sync.

No old source-sync run rows are copied.

## What Is Out of Scope

- Preserving old `source_sync_runs` history.
- A compatibility API for old source-sync run routes.
- More granular per-document source-sync proposals.
- New publication policy controls.
- A new source-sync-specific UI section.

## Testing Strategy

Use focused tests around the changed ownership boundaries:

- no changed source produces no proposal and an honest zero-work job result;
- changed source with no candidate docs records a completed maintenance run and
  no proposal;
- changed source with empty constrained changeset records a completed maintenance
  run and no proposal;
- changed source with non-empty constrained changeset creates exactly one
  proposal, records a source-sync `MaintenanceRun`, and advances baseline;
- a clear source-sync proposal enqueues `publish_proposal`;
- an overlapping touchable proposal enqueues `fold_changeset_proposal`;
- failed or malformed plan output records a failed maintenance run;
- `publish_source_sync` is absent from job catalog, watcher publication runner,
  API completion side effects, and dead-code output;
- web typecheck covers the Proposals and Schedules display changes.

Pre-merge gates: `npm run typecheck`, `npm run typecheck -w @magpie/web`,
`npm test -w @magpie/jobs`, relevant API tests, watcher publication tests, and
`npm run deadcode`.
