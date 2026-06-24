# Source-sync double-publish race fix — implementation plan

> **For agentic workers:** small, single-task fix. Execute inline with TDD. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop `regateDeferredRuns` from enqueuing a redundant `publish_source_sync` job when two source-sync ticks interleave.

**Architecture:** `completeDeferredRun` returns the run only when *this* call performed the `deferred → completed` transition; `undefined` otherwise. The caller gates `enqueuePublication` on a defined result. See `docs/superpowers/specs/2026-06-24-source-sync-double-publish-race-design.md`.

**Tech Stack:** TypeScript ESM, Node built-in test runner, pg.

## Global Constraints

- No schema/migration change — pure logic on existing state.
- In-memory and Postgres stores must stay behaviourally equivalent for this method.
- knip strict: no new unused exports.
- Out of scope: the `completeRun` path in `attachSourceSyncPlanFromCompletedJob`.

---

### Task 1: Tighten `completeDeferredRun` contract + gate the caller

**Files:**
- Modify: `apps/api/src/stores/source-sync-store.ts` (interface doc + in-memory impl)
- Modify: `apps/api/src/stores/postgres-source-sync-store.ts` (drop getRun fallback)
- Modify: `apps/api/src/features/source-sync/service.ts` (`regateDeferredRuns` gate)
- Test: `apps/api/src/stores/source-sync-store.test.ts`
- Test: `apps/api/src/features/source-sync/orchestration.test.ts`

- [ ] **Step 1: Update store contract test (RED).** Replace the existing
  "completeDeferredRun is a no-op on a non-deferred run" assertion (it currently expects
  the unchanged run back) with the new contract: `completeDeferredRun` on a non-deferred
  run returns `undefined`. Add: first `completeDeferredRun` on a deferred run returns the
  completed run; a second call on the same id returns `undefined`; an unknown id returns
  `undefined`.

- [ ] **Step 2: Add the orchestration concurrency test (RED).** Defer a run (overlapping
  open proposal), merge the proposal to clear the overlap, then fire two
  `triggerSourceSyncRun` ticks concurrently with `Promise.all`. Assert exactly one
  `publish_source_sync` job is enqueued and the run ends `completed`.

- [ ] **Step 3: Implement (GREEN).** In-memory: return `undefined` when the run is not
  `deferred`. Postgres: drop the `: this.getRun(id)` fallback so a no-match returns
  `undefined`. Caller: `const completed = await completeDeferredRun(run.id); if (!completed) continue;` before `enqueuePublication`. Update the interface doc comment.

- [ ] **Step 4: Run gates.** `npm run typecheck`, `npm run deadcode`, root `npm test`.

- [ ] **Step 5: Commit.**
