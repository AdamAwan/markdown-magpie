# Intent Trace UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show durable change-intent traces on the Activity page with compact operator chips and a developer detail view.

**Architecture:** Add a shared `ChangeIntentTrace` type to `@magpie/core`, store traces in `MaintenanceRun.details.intentTraces`, and render them from `ActivityPanel`. Generate traces from the existing reconcile gate inputs where maintenance runs already record audit details.

**Tech Stack:** TypeScript, Hono API, Next/React, node:test, React server rendering tests.

---

### Task 1: Shared Trace Contract

**Files:**
- Modify: `packages/core/src/index.ts`
- Test: `apps/api/src/stores/maintenance-run-store.test.ts`

- [ ] Add `MaintenanceLens`, `ChangeIntent`, `ChangeIntentTraceCandidate`, `ChangeIntentTraceOutcome`, and `ChangeIntentTrace` exports to core.
- [ ] Extend `MaintenanceRun.details` documentation to reserve `intentTraces?: ChangeIntentTrace[]`.
- [ ] Add an in-memory store assertion that a run can round-trip `details.intentTraces`.
- [ ] Run `npm run test -w @magpie/api -- apps/api/src/stores/maintenance-run-store.test.ts`.

### Task 2: Trace Builder

**Files:**
- Create: `apps/api/src/scheduling/intent-trace.ts`
- Modify: `apps/api/src/scheduling/reconcile-gate.ts`
- Test: `apps/api/src/scheduling/intent-trace.test.ts`

- [ ] Add helpers that build candidate overlap context from a `ChangeIntent`, open PR summaries, and gate decision.
- [ ] Keep `decideReconciliation` pure; tracing should consume the same inputs without changing the gate decision.
- [ ] Test open-new, fold, and defer traces, including overlap paths and outcome fields.
- [ ] Run `npm run test -w @magpie/api -- apps/api/src/scheduling/intent-trace.test.ts`.

### Task 3: Record Run Traces

**Files:**
- Modify: `apps/api/src/features/patrol/service.ts`
- Modify: `apps/api/src/scheduling/gap-reconciler.ts`
- Test: focused existing patrol/gap reconciler tests if trace insertion affects their assertions.

- [ ] For fix patrol findings, convert existing finding decision data into `intentTraces`.
- [ ] For gap reconciliation, attach traces for drafted/folded/deferred intent decisions where the run already records details.
- [ ] Preserve existing count fields so Activity remains backwards compatible.
- [ ] Run focused API tests for changed files.

### Task 4: Activity UI

**Files:**
- Modify: `apps/web/src/components/ActivityPanel.tsx`
- Modify: `apps/web/src/components/ActivityPanel.test.tsx`
- Modify: `apps/web/src/app/styles.css`

- [ ] Parse traces defensively from `run.details.intentTraces`.
- [ ] Add chips for intent count and decisions.
- [ ] Add a `View trace` disclosure/button that reveals trace cards and raw JSON.
- [ ] Test that Activity renders chips, operator details, and raw debug payload.
- [ ] Run `npm run test -w @magpie/web -- ActivityPanel.test.tsx`.

### Task 5: Verification And PR

**Files:**
- Any files touched above.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test -- --test-name-pattern "intent|Activity|maintenance run"` or focused workspace tests if the full suite is too slow.
- [ ] Run `npm run lint`.
- [ ] Commit the implementation.
- [ ] Push `codex/intent-trace-ui`.
- [ ] Open a draft PR summarizing the UI and audit trace behavior.

## Self-Review

The plan covers the approved design: shared type, durable run details storage, Activity chips, developer trace view, and verification. It deliberately avoids a new Intents page or migration. There are no placeholder tasks; each task names exact files and commands.
