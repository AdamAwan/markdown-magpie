# Route source-sync through the reconcile gate (Scope A)

**Status:** Approved · **Date:** 2026-06-24 · **Author:** Adam

Redesign step 3 from [`docs/maintenance-redesign.md`](../../maintenance-redesign.md):
make the **source-sync** lens emit a change intent and pass through the shared
**reconcile gate** before publishing, so a source-sync change that overlaps an
open PR no longer lands a rival change on the same file. This is the direct
continuation of the gap lens's at-draft fold ([`fold.ts`](../../../apps/api/src/scheduling/fold.ts)),
applied to a second lens.

---

## 1. Background

Source-sync today (`apps/api/src/features/source-sync/service.ts`) reacts to a
source commit, retrieves the candidate KB documents that describe the changed
area, asks the model for a plan, constrains that plan to a **changeset** of file
writes, then publishes the changeset directly via a branch + commit
(`publish_source_sync` — it *raises no PR*). It never goes through the proposal /
PR machinery, so the reconcile gate cannot see it, and it cannot see the gate.

That means a gap PR and a source-sync commit can both touch the same KB file with
no reconciliation — exactly the "two changes fighting over one file" problem the
gate exists to prevent.

### The representation mismatch (why this is Scope A, not B)

The gate (`decideReconciliation` / `openPullRequestSummaries` in
`apps/api/src/scheduling/reconcile-gate.ts`) reconciles **`Proposal`s**: objects
with a single `targetPath`, a `status`, a `reviewDecision`, and a PR. Source-sync
produces a **multi-file `ChangesetChange[]`** published as a branch with no
`Proposal` at all. Bridging that fully — making a source-sync change a
first-class `Proposal` so the gate is *symmetric* (gap and source-sync each see
the other's PRs) and `fold` becomes a real LLM merge — is a large change.

This spec deliberately does the smaller **Scope A**: a one-way guard at the
source-sync completion hook that checks the changeset against open gap proposals
*before* publishing. **Scope B** (source-sync as a first-class proposal) is the
documented end-state and is called out in a prominent code comment at the gate
hook.

### The non-lossy constraint

Source-sync **advances its baseline SHA at enqueue time**
(`store.setState(..., headSha)` in `syncGitSource`). Once a run is in flight, that
commit is never re-detected. So any verdict other than "publish now" **must
preserve the changeset** — dropping it would silently lose the source change
forever. This is why overlap leads to a persisted *deferred* run, not a drop.

---

## 2. Decisions (locked)

- **Scope A — one-way guard.** Source-sync stays changeset-based; the gate runs at
  the source-sync completion hook against open gap proposals in the same flow.
  Asymmetric by design; Scope B is the documented goal.
- **Overlap ⇒ defer-and-preserve.** Both gate verdicts that mean "there is an
  overlap" (`fold` and `defer`) collapse to a single action for this lens:
  persist the changeset on a **`deferred`** run and publish nothing. No LLM fold
  is built in this increment — that is Scope B.
- **Re-gate on the next source-sync tick.** A deferred run is re-evaluated through
  the gate at the top of `triggerSourceSyncRun` for its flow; when the overlap has
  cleared (the blocking PR merged/closed) it publishes, otherwise it stays
  deferred.

---

## 3. Architecture

```
source commit
   │
   ▼
syncGitSource ── enqueue sync_source_changes_generate_plan ──► (watcher: plan)
   │                                                              │
   │  (re-gate deferred runs for this flow, first)                ▼
   │                                          attachSourceSyncPlanFromCompletedJob
   │                                                  │  derive changeset
   │                                                  ▼
   │                                         ┌─ build ChangeIntent(lens="source-sync")
   │                                         │  decideReconciliation(intent, openPRs(same-flow proposals))
   │                                         ▼
   │                      ┌──────────────────┼───────────────────────┐
   │              open-new│              fold │ defer                  │
   │                      ▼                   ▼                        │
   │            completeRun + publish    deferRun (persist            │
   │            (today's path)           changeset, no publish)       │
   └───────────────────────────────────────────────────────────────►┘
         re-gate on next tick: deferred run whose overlap cleared → publish
```

### 3.1 New run state: `deferred`

`SourceSyncRunStatus` (`packages/core/src/index.ts`) gains `"deferred"`. A
deferred run carries its already-derived `changeset` (the field exists today —
reused) and waits for re-gate. **No DB migration is required**:
`source_sync_runs.status` is `text NOT NULL DEFAULT 'running'` with no `CHECK`
constraint (migration `0013`), and `changeset` already persists as JSON.

`deferred` is a **non-terminal, waiting** state, distinct from `skipped` (a change
that needed no KB edit) and `completed` (ready to publish). It has no
`completedAt`.

### 3.2 Store methods (`SourceSyncStore` + in-memory + postgres)

- `deferRun(id, plan, changeset)` — transitions `running → deferred`, persists
  `plan` + `changeset`, sets no `completedAt`, enqueues no publication. Guarded so
  it only acts on a still-`running` run (re-delivery safe), mirroring the existing
  `transitionFromRunning` helper.
- `listDeferredRuns(flowId)` — the re-gate worklist: deferred runs for a flow
  (default flow = `undefined`). Used by the tick re-gate.
- `completeDeferredRun(id)` — transitions `deferred → completed` (the persisted
  `plan` + `changeset` are already present), so the existing publish pre-flight
  (`resolvePublishRepository`, which requires `status === "completed"` + a
  changeset) passes unchanged. Guarded so it only acts on a still-`deferred` run.

### 3.3 Gate hook (`attachSourceSyncPlanFromCompletedJob`)

After `constrainToCandidates`, when the changeset is non-empty (the empty case
still `markSkipped` as today):

1. Resolve the run's same-flow open proposals (see §3.5).
2. Build the intent. `decideReconciliation` consumes only `targets`; `evidence`
   and `rationale` are populated best-effort for logging/observability and the
   future Scope B fold:
   ```ts
   const intent: ChangeIntent = {
     lens: "source-sync",
     flowId: run.flowId,
     targets: changeset.map((c) => normalizeRelativePath(c.path)),
     evidence: changedSourcePaths,            // job input `changes[].path` (best-effort)
     rationale: `source-sync ${run.sourceId} ${run.fromSha}..${run.toSha}`
   };
   ```
3. `const decision = decideReconciliation(intent, openPullRequestSummaries(proposals));`
4. Act:
   - `open-new` → `completeRun(run.id, plan, changeset)` then `enqueuePublication(ctx, run.id)` (today's path, unchanged).
   - `fold` **or** `defer` → `deferRun(run.id, plan, changeset)` + a `console.log`. Both verdicts mean "there is an overlap"; for this lens they collapse to defer.

A prominent comment at this hook records: this is Scope A (one-way guard); why
`fold` collapses to `defer` (no changeset→proposal LLM fold yet); the non-lossy
guarantee; and the Scope B end-state.

### 3.4 Re-gate on tick (`triggerSourceSyncRun`)

Before the per-source loop, for the resolved flow, fetch `listDeferredRuns(flowId)`
and re-evaluate each through the gate:

- Rebuild the intent from the run's persisted `changeset`.
- `decideReconciliation(intent, openPullRequestSummaries(currentSameFlowProposals))`.
- `open-new` (overlap cleared) → `completeDeferredRun(run.id)` + `enqueuePublication(ctx, run.id)`.
- `fold`/`defer` (still overlapping) → leave deferred.

Bounded by the deferred-run count; runs on the existing scheduled cadence
(`POST /source-sync/run`, `trigger: "scheduled"`). Re-gate happens at the flow
level, independent of whether any individual source had a new commit this tick.

### 3.5 Shared flow helper

`proposalFlowId` and the same-flow proposal-gathering loop currently live
file-local in `fold.ts`. Extract them into a small shared module
`apps/api/src/scheduling/flow.ts`:

- `proposalFlowId(ctx, proposal): Promise<string | undefined>`
- `sameFlowOpenProposals(ctx, flowId, excludeId?): Promise<Proposal[]>` — lists
  proposals (cap 200, as today) in the given flow, optionally excluding one id.

`fold.ts` is refactored to consume these (removing its private copies); source-sync
consumes `sameFlowOpenProposals`. Keeps the logic DRY and knip-clean (exported and
used cross-file). `sameFlow` semantics (`(a ?? "") === (b ?? "")`) are preserved.

### 3.6 Path normalisation

Changeset paths are normalised with `normalizeRelativePath` so they match the
stored form of `Proposal.targetPath` — `sharedTargets` does exact string matching,
so a format mismatch would silently never overlap. `openPullRequestSummaries`
already takes `proposal.targetPath` verbatim; the plan pins down `targetPath`'s
stored form and applies the same normalisation on both sides if they differ.

---

## 4. What is explicitly NOT in scope

- No LLM fold of a changeset into a proposal (Scope B).
- No conversion of source-sync to a `Proposal` (Scope B).
- No new job type, prompt, or watcher runner.
- No change to `publish_source_sync` or the publish path itself.
- No DB migration.

---

## 5. Known limitations (documented in code + resolved by Scope B)

- **Asymmetry:** a gap proposal created *after* a source-sync branch was pushed
  won't see that branch (it isn't a proposal), so it won't fold into it.
- **Two deferred runs on the same path** can both publish once the overlap clears
  (there is no source-sync-vs-source-sync gate, since neither is a proposal).

Both are inherent to Scope A and disappear under Scope B.

---

## 6. Testing

In-memory stores + `FakeJobBroker`, mirroring `source-sync/orchestration.test.ts`:

- **No overlap** → `completeRun`; a `publish_source_sync` job is enqueued.
- **Overlap with a touchable proposal** → run is `deferred`, changeset preserved,
  **no** publish job enqueued.
- **Overlap with an approved (non-touchable) proposal** → run is `deferred`
  (same outcome this increment).
- **Re-gate, overlap cleared** (blocking proposal merged/closed) → deferred run
  becomes `completed` and a publish job is enqueued.
- **Re-gate, still overlapping** → run stays `deferred`, no publish job.
- Store-level unit tests for `deferRun` / `completeDeferredRun` / `listDeferredRuns`
  idempotency guards (in-memory; the postgres path is typecheck-only and its store
  test skips without `DATABASE_URL`).

---

## 7. Files touched

- `packages/core/src/index.ts` — add `"deferred"` to `SourceSyncRunStatus`.
- `apps/api/src/stores/source-sync-store.ts` — interface + in-memory:
  `deferRun`, `listDeferredRuns`, `completeDeferredRun`.
- `apps/api/src/stores/postgres-source-sync-store.ts` — same three methods.
- `apps/api/src/scheduling/flow.ts` — **new** shared `proposalFlowId` /
  `sameFlowOpenProposals`.
- `apps/api/src/scheduling/fold.ts` — consume the shared helper.
- `apps/api/src/features/source-sync/service.ts` — gate hook in
  `attachSourceSyncPlanFromCompletedJob`; re-gate in `triggerSourceSyncRun`.
- Tests alongside the above.
