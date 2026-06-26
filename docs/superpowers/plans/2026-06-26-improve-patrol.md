# Improve Patrol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add improve-patrol as a slower single-document patrol that source-grounds fine-but-thin document growth and publishes clusterless `Improve:` proposals through the reconcile gate.

**Architecture:** Add `improve_document` as a provider job and `improve_patrol` as a maintenance job. Reuse the patrol service, source context collection, proposal completion, and single-file fold spine, while adding a cursor kind so improve-patrol does not stamp fix-patrol freshness.

**Tech Stack:** TypeScript, Node test runner, Zod schemas, workspace packages `@magpie/core`, `@magpie/jobs`, `@magpie/prompts`, API services, watcher runners.

---

## File Map

- Modify `packages/core/src/index.ts`: add improve job input/output types.
- Modify `packages/jobs/src/types.ts`, `schemas.ts`, `catalog.ts`, and tests: register `improve_document` and `improve_patrol`.
- Modify `packages/prompts/src/catalog.ts` and tests: add the improve prompt and keep catalog/API counts aligned.
- Modify `apps/watcher/src/job-prompts.ts` and tests: route `improve_document`.
- Modify `apps/watcher/src/runners/maintenance.ts` and tests: run `improve_patrol` through the API.
- Modify `apps/api/src/stores/patrol-store.ts`, `postgres-patrol-store.ts`, and tests: add cursor kind support defaulting to fix.
- Modify `apps/api/src/features/patrol/service.ts`, `routes.ts`, and tests: add `runImprovePatrol` and `/api/fix-patrol/improve/run`.
- Modify `apps/api/src/features/proposals/service.ts` and tests: create idempotent improve proposals from completed jobs.
- Modify `apps/api/src/scheduling/fold.ts` and tests: add `reconcileImproveProposal`.
- Modify `apps/api/src/features/jobs/service.ts` and tests: dispatch improve proposal creation/reconcile on completion.
- Modify `apps/api/src/scheduling/task-registry.ts` and tests: schedule per-flow improve-patrol.
- Modify web job type lists if type unions require it.

## Tasks

### Task 1: Contracts And Prompt Registration

- [ ] Write RED tests in job catalog/schema and prompt routing for `improve_document` and `improve_patrol`.
- [ ] Run `npm test -w @magpie/jobs` and prompt/watcher focused tests; expect failures for unknown job/prompt types.
- [ ] Add core improve input/output types, job schemas, catalog definitions, `JOB_TYPES`, `aiJobTypes`, prompt definition, prompt catalog entry, and watcher `buildPrompt` case.
- [ ] Re-run focused tests; expect pass.

### Task 2: Separate Improve Cursor

- [ ] Write RED store tests showing `stampChecked(..., "improve")` does not appear in the default fix cursor and vice versa.
- [ ] Run `npm test -w @magpie/api -- apps/api/src/stores/patrol-store.test.ts`; expect failure because cursor kind is unsupported.
- [ ] Add optional cursor kind to the patrol store API. Keep default behaviour as fix. In Postgres, namespace the stored `flow_id` for non-fix cursor rows rather than changing schema.
- [ ] Re-run patrol store tests; expect pass.

### Task 3: Improve Patrol Service And Route

- [ ] Write RED patrol service tests proving `runImprovePatrol` selects two docs, uses its improve cursor, collects source context, and enqueues one improve job per selected doc.
- [ ] Run `npm test -w @magpie/api -- apps/api/src/features/patrol/service.test.ts`; expect missing export/failing behaviour.
- [ ] Implement `runImprovePatrol`, default improve enqueue dependency, and an improve route returning `{ runId, selectedCount, enqueuedCount }`.
- [ ] Re-run the patrol service tests; expect pass.

### Task 4: Improve Proposal Completion And Reconcile

- [ ] Write RED proposal and fold tests for silent no-op, idempotent improved proposal creation, open-new publish, touchable fold, and approved-overlap self-publish.
- [ ] Run focused API tests for proposals, fold, and job completion; expect missing functions/dispatch.
- [ ] Implement `createImproveProposalFromCompletedJob`, `reconcileImproveProposal`, and call them from `completeJob`.
- [ ] Re-run focused API tests; expect pass.

### Task 5: Maintenance Scheduling And Runner

- [x] Write RED task-registry and watcher maintenance-runner tests for the per-flow `improve-patrol` task and `improve_patrol` runner.
- [x] Run focused API and watcher tests; expect failures for missing task/runner support.
- [x] Register `improve-patrol` in the task registry, add watcher runner support, and update any UI job type grouping needed for the new maintenance job.
- [x] Re-run focused tests; expect pass.

### Task 6: Full Verification And PR

- [ ] Run focused workspace tests touched by the change.
- [ ] Run pre-PR gates: `npm test`, `npm run typecheck`, `npm run deadcode`.
- [ ] Commit the completed work.
- [ ] Push `codex/improve-patrol` and open a PR against `main`.
