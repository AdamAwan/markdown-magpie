# Verify → corrective PR

**Status:** Design · **Date:** 2026-06-25 · **Author:** Adam

The other half of the verify lens. PR #29 shipped *detect & report*: the fix-patrol
verify lens judges a document against its source material and records a
`VerifyFinding` for every "unprovable" verdict. This increment turns that finding
into an **actual corrective pull request**, routed through the shared reconcile gate
so it folds into — never competes with — an open PR on the same file.

See the north star at [`docs/maintenance-redesign.md`](../../maintenance-redesign.md)
(§3 the gate, §5 fold-on-overlap, §6 verify-vs-source-sync) and the verify-lens
design at [`2026-06-24-verify-lens-design.md`](2026-06-24-verify-lens-design.md).

---

## 1. Goal & non-goals

**Goal.** When the verify lens flags unprovable claims in a document, produce a
corrected version of that document and publish it as a PR through the gate, reusing
the proposal → fold → publish machinery the gap lens already uses. A verify fix and a
gap PR that touch the same file reconcile into one change; nothing spawns a rival.

**Non-goals (deliberately deferred).**

- **Per-doc cited-source resolution.** The corrective job sees the *flow's* source set
  (the same material the verify job saw), not the document's specifically-cited
  sources. Carried over from the verify lens; out of scope here.
- **`lastVerified` write-back.** A healthy or freshly-corrected doc is not stamped
  beyond the cursor's `lastCheckedAt`.
- **Other patrol lenses.** dedupe / split / complete are untouched. (The flow-identity
  generalisation in §2 is built to serve them next, but they are not built here.)
- **Deleting the document.** A correction only ever rewrites the doc's content; it
  never deletes the file.

---

## 2. Data model — first-class `Proposal.flowId`

Today a `Proposal`'s flow is derived **entirely** from its `gapClusterId`
(`proposalFlowId` in [`flow.ts`](../../../apps/api/src/scheduling/flow.ts) and the
cached copy in
[`gap-reconciler.ts`](../../../apps/api/src/scheduling/gap-reconciler.ts)). A
verify-driven proposal has no cluster, so it would resolve to the *default* flow —
breaking both the gate's same-flow candidate set (`sameFlowOpenProposals`) and the
per-flow publication-outbox draining (`flowPendingActions`) for every non-default
flow.

**Change.** `Proposal` gains an optional `flowId?: string` (migration **0029**, both
the in-memory and Postgres proposal stores). `proposalFlowId` becomes:

```
proposalFlowId(p) = p.flowId ?? <existing gapCluster lookup>
```

applied in **both** copies. Gap proposals leave `flowId` unset and keep the cluster
path bit-for-bit unchanged. Verify (and later dedupe/split/complete) proposals set
`flowId` directly. This single generalisation is what lets a clusterless proposal be
seen as same-flow by the gate and drained by its flow's outbox.

---

## 3. New AI job — `correct_document`

`verify_document` stays the **pure judge** (unchanged — still detect & report). A new
`correct_document` job does the **repair**, and runs only for unprovable documents.

- **Input:** `{ path, content, claims: UnprovableClaim[], sources: SourceDataContext[],
  destinationId?, flowId?, provider }`
- **Output:** `{ markdown, rationale }`

**Appetite — repair-or-remove.** For each flagged claim the model either (a) rewrites
it to match a supporting source excerpt, or (b) removes it when nothing in the
provided sources supports it. The prompt grounds every rewrite in the supplied
excerpts and forbids introducing unsupported assertions — the fabrication guard. The
output is the full corrected document body.

**Registration chores (the new-AI-job checklist):**

- `JOB_TYPES` + `EXPIRATION_SECONDS` in `@magpie/jobs`.
- The `aiJobTypes` set in `catalog.ts`, plus a routing assertion in
  `catalog.test.ts`.
- Input/output zod schemas in `@magpie/jobs` (`correctDocumentInputSchema`,
  `correctDocumentOutputSchema`) and the `VerifyDocumentJobOutput`-style core types.
- A new prompt in `@magpie/prompts` — bumps the prompt count/order assertions in
  `prompts/catalog.test.ts` **and** the `/api/prompts` count in
  `apps/api/src/app.test.ts`.
- A `job-prompts.ts` entry so the watcher runs it generically.

---

## 4. Trigger — fix-patrol enqueues the correction

`runVerifyLens` stays pure detect-and-report (returns `VerifyFinding[]`); it is *not*
coupled to correction, so it remains reusable for a report-only patrol.

`runFixPatrol` orchestrates: after the lens returns, for **each unprovable finding**
it enqueues one `correct_document` job (enqueue-only — mirrors the gap draft and
source-sync plan patterns; nothing blocks the maintenance POST). It maps each finding
back to its selected document's content (already in `selectedDocuments`), the
already-collected `sources`, and the document's `repositoryId` (→ `destinationId`).

A `correctDocument` dependency is injected exactly like the existing `verifyDocument`
dep, so offline tests assert the enqueue (or inject a deterministic fake) without a
real job.

**Consequence — the finding's `decision` becomes a preview.** `runVerifyLens` still
records an eager gate decision on each `VerifyFinding` for the patrol-run audit trail,
but the **authoritative** fold/defer/open-new is decided later, at draft-completion
(§5), against fresh PR state. The recorded decision is documentation, not the action.

---

## 5. Proposal birth, reconcile & publish

A new completion handler is added to the fixed `completeJob` sequence in
[`features/jobs/service.ts`](../../../apps/api/src/features/jobs/service.ts), guarding
`job.type === "correct_document"`. Because the existing at-draft fold hook
(`reconcileDraftedProposal`) only fires for `draft_markdown_proposal` output, the new
handler owns the corrective-proposal lifecycle without disturbing the gap path.

1. **Create the draft proposal.** `ctx.stores.proposals.create({ title, targetPath:
   path, markdown: output.markdown, rationale: output.rationale, flowId, destinationId,
   jobId })`. Title is derived (`Verify: correct unprovable claims in <path>`).
   **Idempotent on `jobId`:** if a proposal already records this `jobId`, the handler
   is a no-op, so a re-delivered completion never creates a duplicate.

2. **Reconcile.** Call a new `reconcileCorrectiveProposal(ctx, proposal)` in
   [`fold.ts`](../../../apps/api/src/scheduling/fold.ts). It runs `decideReconciliation`
   against `openPullRequestSummaries(sameFlowOpenProposals(ctx, flowId, proposal.id))`:

   | Verdict | Action |
   | --- | --- |
   | **fold** | enqueue the existing `fold_markdown_proposal` job (verify fix folds into the open PR) |
   | **defer** | publish as its own PR (overlap is an *approved* PR; the #21 cross-link backstop flags it) |
   | **open-new** | publish as its own PR |

   This is `reconcileDraftedProposal` plus an `open-new → publish` branch. It is a
   **separate** function rather than an overload: gap's `open-new` deliberately
   no-ops (the cluster reconciler owns gap publication), whereas a clusterless verify
   proposal owns its own publication.

3. **Publish — via the per-flow outbox.** Both `defer` and `open-new` call
   `enqueuePublicationAction(proposal.id, "publish")`. That flow's
   gap-reconciler tick drains the outbox (`drainPublicationOutbox` →
   `requestProposalPublication` → `publish_proposal` job → branch + PR), now correctly
   flow-scoped because `flowPendingActions` resolves the proposal's flow via the
   generalised `proposalFlowId` (§2). Same machinery, retry bookkeeping, and
   idempotency as every gap PR; the PR appears on the gap-reconciler cadence.

---

## 6. Labelling

The corrective PR is tagged distinctly from a gap PR (a title prefix and a body
marker identifying it as a fix-patrol / verify correction), satisfying the north
star's "easy to triage apart" requirement (§4 of the redesign): a verify PR fixes a
demonstrable problem, quick to approve.

---

## 7. Error handling & idempotency

- **Correction job fails / returns malformed output** → no proposal is created; the
  `VerifyFinding` recorded by the patrol run still stands, so detect-&-report is never
  regressed. Mirrors source-sync's degrade-on-failure.
- **Re-delivered `correct_document` completion** → idempotent on `jobId` (§5.1): no
  duplicate proposal.
- **Fold guard rails reused** as-is: touchability (an approved PR is non-touchable →
  defer), and the cross-link backstop for deferred overlaps.
- **Repair safety** is the prompt's job: every retained claim must map to a provided
  source excerpt, else it is removed.

---

## 8. Testing (inline TDD)

- `proposalFlowId` prefers `proposal.flowId`, falls back to cluster (both copies).
- `correct_document` input/output schema validation; catalog routing; prompt
  count/order; `/api/prompts` count.
- `reconcileCorrectiveProposal`: `open-new` → publish action enqueued; `fold` → fold
  job enqueued; `defer` (approved overlap) → publish action enqueued.
- `createCorrectiveProposalFromCompletedJob`: creates a draft proposal carrying
  `flowId`; idempotent on `jobId`.
- `runFixPatrol`: enqueues one `correct_document` per unprovable finding (injected
  `correctDocument`); healthy docs enqueue none.
- Watcher test-file stubs for any new `WatcherApi` surface (expected: none — the
  correction is a generic AI job run via `job-prompts.ts`).

Pre-PR gates: `npm test` + `npm run typecheck` + `npm run deadcode` (knip strict —
de-export, never relax). Workspace tests run via `npm test -w @magpie/<pkg>`.

---

## 9. End-to-end flow

```
fix-patrol tick
  └─ runVerifyLens → VerifyFinding[] (unprovable + claims)        [detect, PR #29]
       └─ runFixPatrol: per unprovable finding → enqueue correct_document   [§4]
            └─ watcher runs correct_document → { markdown, rationale }      [§3]
                 └─ completeJob: createCorrectiveProposalFromCompletedJob   [§5.1]
                      └─ draft Proposal { flowId, targetPath, markdown }
                           └─ reconcileCorrectiveProposal                   [§5.2]
                                ├─ fold   → fold_markdown_proposal job
                                ├─ defer  → enqueuePublicationAction(publish)
                                └─ open   → enqueuePublicationAction(publish)
                                     └─ gap-reconciler tick drains outbox   [§5.3]
                                          └─ publish_proposal → branch + PR  (labelled, §6)
```
