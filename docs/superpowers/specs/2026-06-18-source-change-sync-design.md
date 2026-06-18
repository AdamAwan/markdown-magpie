# Source-change sync — design

**Date:** 2026-06-18
**Status:** First slice implemented (direct mode, git sources, review-branch output)

## Problem

The knowledge base **describes** its sources (code/data); it is not a copy of them.
When an upstream source commit changes the underlying behaviour the KB documents
(e.g. an "old item" cutoff moves from `2024` to `2025`), any KB document that still
asserts the old fact is now wrong. Nothing currently notices this.

This is distinct from **Crunch**, which reorganises the KB against *itself*
(consolidate/split). Source-change sync corrects the KB against its *sources*.

## Approach

A new scheduled task, `source-change-sync`, registered in the task registry
([task-registry.ts](../../../apps/api/src/scheduling/task-registry.ts)) and driven
by the existing `TaskScheduler`. It reuses Crunch's back half — `CrunchPlan` →
`changesetFromPlan` → `LocalGitProposalPublisher` → review branch.

Pipeline, per flow, per git source ([service.ts](../../../apps/api/src/features/source-sync/service.ts)):

1. **Detect** — `ensureGitCheckout` (fetch/pull) → `getHeadSha`. Compare to the
   last processed SHA in `source_sync_state`. First sighting records a baseline
   and reacts to nothing (no history replay). Unchanged HEAD → no-op.
2. **Diff** — `diffChangedFiles(from, to, { subpath })` returns changed files with
   capped per-file patches, scoped to the source's configured subpath.
3. **Gate ("if the KB already contains that info")** — retrieve KB sections for the
   change (hybrid search, scoped to the flow's destination), collapse to distinct
   candidate documents. **No candidates ⇒ skipped run, advance baseline.**
4. **Plan** — model (`SOURCE_CHANGE_SYNC` prompt) gets the diffs + candidate docs and
   rewrites only the documents the change outdates, as a `CrunchPlan`. Mock provider
   returns an empty plan (it can't reason about a diff).
5. **Constrain** — drop deletes and any path outside the candidate set
   (defence-in-depth: a source-sync corrects existing docs, never removes them).
6. **Publish** — changeset → `magpie/source-sync-<run>` branch (+ PR when
   `GITHUB_TOKEN` is set, via the existing publisher).
7. **Advance baseline** once a run is recorded. Generation failure leaves the
   baseline so it retries; a publish failure is surfaced on the run, not re-planned.

## Data

- `source_sync_state (flow_id, source_id, last_sha, last_checked_at)` — PK
  `(flow_id, source_id)`; default flow stored as `''`.
- `source_sync_runs` — history (status: running/completed/failed/skipped/published).

Migration: [0013_source_sync.sql](../../../packages/db/migrations/0013_source_sync.sql).
Stores: in-memory + postgres, factory in `platform/stores.ts`, wired into `AppContext`.

## Defaults / decisions

- **Cron poll** (`*/10 * * * *`), disabled until enabled from the Crunch page —
  the task auto-appears there via `scheduledTasksForResponse`; no web changes needed.
- **Review branch, never auto-merge** — consistent with proposals/Crunch.
- **git sources only** in this slice.

## Not yet done (later slices)

- Queue-mode execution (a `sync_source_change` ai_job for the watcher; the type and
  job input already exist). The scheduled task currently plans in-process.
- Dedicated HTTP endpoints / UI for source-sync runs (runs are persisted + logged).
- `local`/`internet`/`agent` sources.
