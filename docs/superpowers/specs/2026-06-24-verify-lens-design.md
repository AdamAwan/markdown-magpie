# Verify lens (fix-patrol) — design

**Status:** Spec · **Date:** 2026-06-24 · **Author:** Adam (with Claude)

The first concrete fix-patrol lens. Builds on the cursor skeleton (PR #28): `runFixPatrol`
already selects a rolling batch of documents and records a `PatrolRun`. This increment fills
the **marked no-op lens slot** with the **verify** lens.

See the north star: [`docs/maintenance-redesign.md`](../../maintenance-redesign.md) §2, §6.

---

## 1. Goal & scope

For each document the cursor selects, re-check whether the doc's claims are still **provable**
against its source material. When the model can't substantiate a claim, emit a `verify`
`ChangeIntent`, run it through the existing reconcile gate, and **record the finding** on the
`PatrolRun`. Stay **silent** on healthy docs (the conservative fix-patrol contract).

**In scope (this increment — "detect & report through the gate"):**

- A `verify_document` AI job: one document + its sources → a provability verdict.
- A verify lens that turns a verdict into a `ChangeIntent` and runs it through
  `decideReconciliation`.
- Findings recorded on the `PatrolRun` (path, unprovable claims, gate decision).
- `runFixPatrol` wired to run the lens over the selected batch.

**Out of scope (explicitly deferred):**

- **No corrective changeset or PR.** Detecting drift is the novel, hard part; turning a finding
  into a PR reuses source-sync's draft→changeset→publish machinery and is a follow-up increment.
- **No per-claim source citations.** KB documents carry no citation metadata
  (`KnowledgeDocument.metadata` has `lastVerified`/`relatedDocs` but no source links), so
  "its cited sources" is approximated by the **flow's source set** (the same material the drafter
  used — see `collectSourceContext`). Narrowing to per-claim sources is a future refinement.
- **No `metadata.lastVerified` write-back.** The cursor's `lastCheckedAt` (already stamped by
  `stampChecked`) is the record of "when did we last verify this"; writing the doc's metadata
  would require a PR and is out of scope.

---

## 2. Architecture & data flow

`runFixPatrol` runs **synchronously inside the API** when the watcher's `MaintenanceRunner`
POSTs `/api/fix-patrol/run`. The verify judgement needs the LLM, which lives in the watcher. We
reuse the **established `runJobToCompletion` bounded-wait** pattern (exactly how
`gap-reconciler.ts`'s `requestReshape` enqueues `reconcile_gap_clusters` and waits for it): the
API enqueues a provider AI job and bounded-waits for the watcher to complete it. This is safe
because the watcher heartbeats the `fix_patrol` maintenance job on an **independent background
timer** ([`worker-loop.ts` `startHeartbeat`](../../../apps/watcher/src/worker-loop.ts)), so the
job stays alive while the API does long work.

```
fix_patrol (maintenance job, watcher)
  └─ POST /api/fix-patrol/run
       └─ runFixPatrol (API)
            1. select batch (existing cursor)
            2. collect flow source context ONCE  (collectSourceContext, cached)
            3. for each selected doc:
                 enqueue verify_document  ──►  ChatRunner (watcher) ──► verdict
                 (bounded-wait via runJobToCompletion)
                 if "unprovable":
                   build ChangeIntent(lens:"verify", targets:[path], evidence:[claims])
                   decideReconciliation(intent, openPullRequestSummaries(sameFlowOpenProposals))
                   record a finding {path, claims, decision}
            4. stampChecked (existing)
            5. createRun({..., findings})   (existing + findings)
```

The lens is **conservative end-to-end**: the model defaults a claim to healthy unless the
sources actively fail to support it (prompt instruction); a healthy verdict produces no finding
and no intent. A doc whose verify job fails/times out is skipped (logged), not failed — one bad
doc never aborts the patrol tick (mirrors source-sync's per-source isolation).

### Injectable AI boundary (for offline tests)

`runFixPatrol` takes an optional `deps` parameter carrying `verifyDocument(ctx, input) =>
Promise<VerifyDocumentJobOutput>` — mirroring `gap-reconciler.ts`'s `ReconcilerDeps`. The default
implementation enqueues `verify_document` and bounded-waits via `runJobToCompletion`; unit tests
inject a deterministic fake, so the patrol service tests stay offline (no broker worker needed).

---

## 3. Components

### 3.1 `verify_document` AI job (`@magpie/jobs`, `@magpie/core`)

- **Input** `verifyDocumentInputSchema` = `{ path: string, content: string, sources:
  SourceDataContext[], provider }`. Reuses the existing `sourceDataContextSchema` and
  `providerSchema`.
- **Output** `verifyDocumentOutputSchema` = `{ verdict: "healthy" | "unprovable", claims:
  Array<{ claim: string, reason: string }> }`. `claims` is empty when healthy.
- **core types**: `VerifyDocumentJobInput` (`{ path; content; sources: SourceDataContext[] }`,
  provider added at enqueue, matching `SourceChangeSyncJobInput`), `VerifyDocumentJobOutput`,
  `UnprovableClaim`.
- **catalog**: `verify_document: define("verify_document", "provider", …, 10 * 60)`; add to the
  `aiJobTypes` set; add `"verify_document"` to `JOB_TYPES` (after `sync_source_changes_generate_plan`).
- **catalog.test**: add `verify_document: 10 * 60` to `EXPIRATION_SECONDS`; add it to the AI-queue /
  provider-fanout assertions as the existing tests require.

### 3.2 Prompt (`@magpie/prompts`)

`VERIFY_DOCUMENT` — instructs the model to check each substantive claim in the document against
the supplied sources and return the JSON contract. **Conservative**: flag a claim only when the
sources contradict it or clearly fail to support it; when unsure, treat it as healthy. Silence
(verdict `healthy`, empty `claims`) is the expected output for most docs.

### 3.3 Watcher wiring (`apps/watcher`)

- `job-prompts.ts` `buildPrompt`: add a `case "verify_document"` using `VERIFY_DOCUMENT.instructions`.
- `chat.ts` `CHAT_JOB_TYPES`: add `"verify_document"`. The generic chat path (`buildPrompt` +
  `parseJobOutput`) handles it; no special branch needed.

### 3.4 Verify lens (`apps/api/src/scheduling/verify-lens.ts`)

A focused module, pure and unit-tested:

- `verifyIntent(flowId, path, claims): ChangeIntent` — builds the `verify` intent
  (`lens:"verify"`, `targets:[path]`, `evidence: claims.map(c => c.claim)`, a rationale). Pure.
- The orchestration helper `runVerifyLens(ctx, { flowId, documents, sources, verifyDocument })`
  that loops the selected documents, calls the injected `verifyDocument`, and for each
  `unprovable` verdict builds the intent, calls `decideReconciliation` against
  `openPullRequestSummaries(await sameFlowOpenProposals(ctx, flowId))`, and returns
  `VerifyFinding[]`. Per-doc failures are caught and skipped.

`MaintenanceLens` in `intent.ts` is currently file-local. `verify-lens.ts` imports the exported
`ChangeIntent` (already exported), so no change to `intent.ts` is required.

### 3.5 Findings on the run (`@magpie/core`, patrol stores)

- **core**: `VerifyFinding = { path: string; claims: UnprovableClaim[]; decision:
  "open-new" | "fold" | "defer"; intoProposalId?: string }`; add `findings: VerifyFinding[]` to
  `PatrolRun`.
- **`PatrolRunInput`** (`patrol-store.ts`): add `findings: VerifyFinding[]`.
- **`InMemoryPatrolStore`**: persist and return `findings` on the run.
- **`PostgresPatrolStore`**: persist `findings` (new `findings jsonb NOT NULL DEFAULT '[]'`
  column); read it back in `mapRun`.
- **migration `0028_patrol_findings.sql`**: `ALTER TABLE patrol_runs ADD COLUMN findings jsonb
  NOT NULL DEFAULT '[]'::jsonb;`

### 3.6 `runFixPatrol` (`apps/api/src/features/patrol/service.ts`)

Replace the no-op slot: keep the `KnowledgeDocument`s for the selected paths (need their
`content`), collect the flow's source context once (`collectSourceContext` over the flow's
`sourceIds`, or all sources for the default flow), call `runVerifyLens`, pass the resulting
`findings` to `createRun`. Extend the log line and `FixPatrolOutcome` flows unchanged. Add
`findingCount` to `fixPatrolOutputSchema` for watcher-side observability.

### 3.7 Output schema & watcher stubs

`fixPatrolOutputSchema` gains `findingCount: z.number().int()`. Update the watcher
`runFixPatrol` runner to read/return it and the `WatcherApi.runFixPatrol` return type, then the
four test stubs (`maintenance`, `publication`, `refresh-pull-requests`, `chat`).

---

## 4. Error handling

- **Per-doc verify failure/timeout** → caught, logged, doc skipped (no finding); cursor is still
  stamped so it rotates normally. One doc can't abort the tick.
- **Malformed model output** → `runJobToCompletion` returns a non-completed/!parseable result;
  the default `verifyDocument` treats it as "skip this doc" (no finding), never throws into the
  tick.
- **No sources configured** → `collectSourceContext` returns context entries describing the
  absence; the model is told it has nothing to verify against and should return `healthy`
  (we don't manufacture findings from missing sources).
- **Unknown flow** → unchanged (existing `unknown_flow` guard, before any verify work).

---

## 5. Testing

- **jobs**: `schemas.test.ts` round-trips `verify_document` input/output and rejects a bad
  verdict; `catalog.test.ts` updated for the new type.
- **prompts**: covered by the package's existing structural prompt tests (export shape).
- **watcher**: `job-prompts.test.ts` asserts `buildPrompt` uses the verify instructions for a
  `verify_document` job; `chat.test.ts` asserts `supports("verify_document")`.
- **verify-lens.test.ts** (pure + orchestration with injected `verifyDocument`):
  - healthy verdict → no finding, no intent;
  - unprovable verdict, no overlapping PR → finding with `decision:"open-new"`;
  - unprovable verdict overlapping a touchable open PR → `decision:"fold"` + `intoProposalId`;
  - a throwing `verifyDocument` for one doc → that doc skipped, others still processed.
- **patrol service.test.ts**: inject a fake `verifyDocument`; assert findings land on the run,
  the cursor is stamped for every selected doc regardless of verdict, and `findingCount` matches.
- **patrol-store.test.ts / postgres-patrol-store.test.ts**: round-trip `findings`.

---

## 6. Global constraints

- TypeScript ESM; local imports use `.js`, `@magpie/*` imports do not.
- knip runs **strict** (`npm run deadcode`): a new export consumed only in-file is flagged —
  de-export, never relax the config.
- Run workspace tests with `npm test -w @magpie/<pkg>` (root-cwd `node --test` resolves
  `@magpie/*` to stale `dist`).
- Pre-PR gates: `npm test`, `npm run typecheck`, `npm run deadcode` all green.
- UK English in copy/comments.
