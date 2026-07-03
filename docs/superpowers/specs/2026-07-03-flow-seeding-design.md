# Flow seeding — targeted authoring into a flow

**Status:** Design · **Date:** 2026-07-03 · **Author:** Adam

Today the only way to put initial content into a new flow is indirect: ask an LLM (over
the MCP) to fire questions at `kb.ask`, let each weak answer log a knowledge gap, and wait
for the demand-driven maintenance pipeline to turn those gaps into PRs. That pipeline is
built to be **careful about evolving existing knowledge** — it clusters gaps
(`reconcile_gap_clusters`), runs the intent/reconcile gate, and drives everything on the
`*/10` and `*/5` crons. On a brand-new flow there is nothing to cluster against and no
demand to infer, so all of that is pure latency and cost.

This design adds a **direct authoring path**: you tell the system *what to cover*, and it
drafts one document per topic straight into proposals → PRs, skipping the gap-clustering
and intent half entirely while keeping the fold/publish half (so it is also safe for
adding a *new area* to an existing flow, not just cold starts).

See the north star at [`docs/maintenance-redesign.md`](../../maintenance-redesign.md)
(§3 the gate, §5 fold-on-overlap) and the closest structural precedent, the verify →
corrective PR design at
[`2026-06-25-verify-corrective-pr-design.md`](2026-06-25-verify-corrective-pr-design.md) —
seeding reuses the same "clusterless proposal → gate → self-publish" machinery.

---

## 1. Goal & non-goals

**Goal.** Given a flow and a list of *seed items* (each ≈ one intended document, described
by a title and the points it should cover), draft each item directly into a proposal and
publish it as a PR through the shared reconcile gate — with no gap clustering, no intent
inference, and no cron wait. Works identically for a cold-start flow (all-new files) and
for adding a new knowledge area to an existing flow (fold/revise on overlap).

**Non-goals (deliberately deferred to v2).**

- **System-generated outlines.** v1 takes the item list as given (authored by the caller's
  interviewer LLM, a script, or the future UI). The `outline_flow_seed` job that *proposes*
  the item list from a topic is v2 (§8).
- **Web console UI.** The v1 surface is the API endpoint + the `kb.seed` MCP tool. The admin
  form is v2 (§8).
- **Revising an existing doc in place.** When a seed item's target path collides with a doc
  already on disk, v1 drafts a *new* proposal for that path and lets the gate fold/replace
  it like any other overlapping change; a dedicated "load the existing doc and revise it"
  drafting mode is a v2 refinement.
- **New gap/cluster rows.** Seeding never mints gaps or clusters — that is the whole point.

---

## 2. The shared contract — `SeedItem` / `SeedSpec`

Both the executor (v1) and the outline generator (v2) speak one shape, defined in
`@magpie/core`:

```ts
export interface SeedItem {
  // Optional human title for the doc; the drafter derives one if omitted.
  title?: string;
  // Optional destination-relative path; the drafter resolves one from the title if omitted.
  targetPath?: string;
  // What this document should cover — the points to author. Plays the role gap
  // summaries play on the demand path. At least one required.
  coverage: string[];
  // Optional Q&A / prompts that motivated this doc, passed to the model as context
  // (the seed analogue of a gap's triggering questions).
  questions?: string[];
}

export interface SeedSpec {
  flowId: string;
  items: SeedItem[];
}
```

`coverage` is the substantive field; everything else is optional shaping. One `SeedItem`
produces exactly one draft job → one proposal → (at most) one PR.

---

## 3. Why a dedicated `draft_seed_document` job (not `draft_markdown_proposal`)

The obvious reuse — call `draftFromGaps` — does **not** work: `draftFromGaps`
(`apps/api/src/features/proposals/service.ts:389`) matches every summary against
already-**logged** gap candidates (`listGapCandidates`, `service.ts:412-419`) and returns
`gap_candidate_not_found` for anything unmatched. Seed coverage strings are not logged
gaps, so that path rejects them by design.

Rather than fabricate synthetic gap rows (a hack that would pollute the gaps store and drag
seed content back through gap semantics), seeding gets its **own AI job type**,
`draft_seed_document`. This is exactly how every other clusterless proposal source is
structured — `correct_document`, `dedupe_documents`, `split_document`, `improve_document`
each have their own job + `createXFromCompletedJob` + `reconcileX` rung in the `completeJob`
ladder (`apps/api/src/features/jobs/service.ts:155-206`). Seeding slots in as one more rung.

- **Input:** `{ provider, flowId, title?, targetPath?, coverage: string[], questions?:
  string[], sourceContext: SourceDataContext[], destinationId? }`
- **Output:** `{ title, targetPath, markdown, rationale }` (same shape as the gap drafter's
  output, so downstream proposal creation is uniform).

**A seed-specific prompt (`DRAFT_SEED_DOCUMENT`).** The gap drafter's prompt is framed
around "fill this knowledge gap that users hit"; seeding is "author a *new* document that
covers these points, grounded in the source material." A distinct prompt produces better
cold-start docs and keeps the gap prompt untouched. The prompt grounds every claim in the
supplied `sourceContext` and forbids inventing unsupported facts — the same fabrication
guard the corrective and gap prompts use.

---

## 4. Enqueue — `seedFlow` skips clustering + intent

A new service function drafts each item **directly**, with none of the demand-inference
machinery:

```
seedFlow(ctx, flowId, items):
  for each item:
    resolve the flow's sources + destination   (selectFlow / flow config)
    collect source context                      (collectSourceContext, memoised across items)
    enqueue draft_seed_document { flowId, title, targetPath, coverage, questions, sourceContext, destinationId }
  return the enqueued job ids
```

It reuses the *flow/source/destination resolution* and *source-context collection* helpers
that `draftFromGaps` uses, but **not** the gap-candidate lookup. It is enqueue-only, exactly
like every other drafter — nothing blocks on the model. What it deliberately bypasses versus
the current MCP-question approach:

- **No `reconcile_gap_clusters`** clustering job.
- **No intent/reconcile gate at cluster time** (`reconcile-gate.ts`).
- **No `*/10` cron wait** — `seedFlow` enqueues synchronously on request.

The source-context collection is memoised across items in one seed call (a `SourceContextCache`,
as the gap reconciler already does across a run) so seeding N docs from one flow reads the
sources once.

---

## 5. Completion — clusterless proposal, gated, self-published

A completed `draft_seed_document` job is handled by a new rung in `completeJob`, mirroring
`correct_document` (`jobs/service.ts:166-179`):

1. **Create the draft proposal** — `createSeedProposalFromCompletedJob(ctx, job, output)`
   creates a `Proposal` carrying **`flowId` first-class** (the field added for the corrective
   PR; `packages/core/src/index.ts`), its `targetPath`, `markdown`, `rationale`, and
   `jobId`. **Idempotent on `jobId`** (the store de-dupes), so a re-delivered completion
   never doubles a doc. No `gapClusterId` — seed proposals are clusterless.

2. **Reconcile + publish** — `reconcileSeedProposal(ctx, proposal)`. This is behaviourally
   identical to `reconcileCorrectiveProposal` (`fold.ts:70`): gate the proposal's target
   path against the flow's open proposals via `decideReconciliation`, then

   | Verdict | Action |
   | --- | --- |
   | **fold** | enqueue the existing `fold_markdown_proposal` job (the seed doc folds into an open PR on that path) |
   | **defer** | publish as its own PR (overlap is an *approved* PR; the cross-link backstop flags it) |
   | **open-new** | publish as its own PR |

   Because the two functions are identical, v1 **extracts the shared body** into
   `reconcileClusterlessProposal(ctx, proposal, lens)` and has both `reconcileCorrectiveProposal`
   and `reconcileSeedProposal` delegate to it (verify passes `lens: "verify"`, seed passes
   `lens: "gap"` — `lens` is cosmetic; only `targets` drive `decideReconciliation`). This is
   a refactor that keeps verify behaviour bit-identical, not new gate logic.

3. **Publish via the per-flow outbox** — both `defer` and `open-new` call
   `enqueuePublicationAction(proposal.id, "publish")`; the flow's outbox drains it into a
   `publish_proposal` job → branch + PR. Same publication machinery, retry bookkeeping, and
   idempotency as every other PR, now correctly flow-scoped because the proposal carries
   `flowId`.

**This is the answer to "publish vs review":** there is exactly one human gate — the PR —
same as everywhere else in the system. Seeding just reaches it without the reconciler-cron
wait that gap drafts incur (a gap draft's `open-new` deliberately no-ops in
`reconcileDraftedProposal` and waits for the cron; a clusterless seed proposal owns its own
publication, like the patrol lenses).

---

## 6. Trigger surfaces (v1)

**API — `POST /api/flows/:flowId/seed`.** A new `seedRoutes(ctx)` router mounted under
`/api`, following `gaps/routes.ts` exactly: `requireScopes("manage:jobs")` +
`assertCan(ctx, c, "manage", flowId)`, a `zValidator` body, and 404-hiding for flows the
caller can't see. Body: `{ items: SeedItem[] }` (at least one item; each item's `coverage`
non-empty). Returns `{ ok: true, jobIds }`.

**MCP — `kb.seed`.** A fifth MCP tool (`apps/mcp/src/main.ts`), declared alongside
`kb.ask`/`kb.flows`/`kb.search`/`kb.feedback` and dispatched in `callTool`, backed by a new
`seedFlow` method in `kb-client.ts` that POSTs the spec to the endpoint above. This is how
an interviewer LLM submits a finished outline in one shot instead of streaming questions
into `kb.ask` and waiting for the gap pipeline.

---

## 7. Error handling & idempotency

- **A seed draft job fails / returns malformed output** → no proposal for that item; the
  other items are unaffected (each item is an independent job). Enqueue-only means a
  never-completing job simply never drafts.
- **Re-delivered `draft_seed_document` completion** → idempotent on `jobId`: no duplicate
  proposal.
- **Two seed items target the same path, or a seed item hits an existing open PR** → the
  fold gate reconciles them (`fold` verdict) instead of racing two PRs on one file.
- **Fold guard rails reused** as-is (touchability, cross-link backstop).

---

## 8. v2 sketch — outline generation + UI

v1 makes the *executor*. v2 makes it easy to drive.

**`outline_flow_seed` AI job.** Input: a topic + optional freeform notes/source pointers +
the flow id. The job (grounded in the flow's *existing* docs via retrieval, so it proposes
docs that fit the current structure and don't restate what's already there) returns a
proposed `SeedItem[]` for the caller to edit and approve. This is the one genuinely new AI
job type v2 adds (full new-AI-job checklist), and it is what lets the UI generate an outline
without an external interviewer LLM. It does **not** draft anything — its output feeds the
v1 `POST /flows/:id/seed` endpoint after human approval.

```
topic + notes → outline_flow_seed (retrieval-grounded) → SeedItem[]   [propose]
   → human edits/approves in the console                              [review the plan]
      → POST /flows/:id/seed (v1)                                     [execute]
```

**Web console UI.** A "Seed / add an area" form in the admin app: pick a flow, enter a
topic, hit **Generate outline** (→ `outline_flow_seed`), edit the proposed items, hit
**Seed** (→ the v1 endpoint). The generated PRs then flow into the normal review queue.

---

## 9. Testing (inline TDD)

- `draft_seed_document` input/output schema validation; catalog routing; prompt count/order
  (17 → 18); `/api/prompts` count (17 → 18).
- `seedFlow` enqueues one `draft_seed_document` per item, carrying `flowId`, `coverage`,
  honouring `targetPath`; does **not** touch the gaps store; unknown flow rejected.
- `reconcileClusterlessProposal` extraction leaves `reconcileCorrectiveProposal` behaviour
  unchanged (existing verify tests stay green); `reconcileSeedProposal`: `open-new` →
  publish action, `fold` → fold job, `defer` → publish action.
- `createSeedProposalFromCompletedJob`: creates a draft carrying `flowId`; idempotent on
  `jobId`.
- `POST /flows/:id/seed`: validates body, 404 on unknown/unauthorised flow, returns job ids.
- `kb.seed` client method POSTs the spec; tool is listed by `tools/list`.

Pre-PR gates: `npm test` + `npm run typecheck` + `npm run deadcode` (knip strict —
de-export, never relax). Workspace tests via `npm test -w @magpie/<pkg>`.

---

## 10. End-to-end flow (v1)

```
POST /api/flows/:id/seed  (or kb.seed)   { items: SeedItem[] }
  └─ seedFlow: per item → enqueue draft_seed_document                 [§4, no clustering]
       └─ watcher runs draft_seed_document → { title, targetPath, markdown, rationale }  [§3]
            └─ completeJob: createSeedProposalFromCompletedJob        [§5.1]
                 └─ draft Proposal { flowId, targetPath, markdown }
                      └─ reconcileSeedProposal → reconcileClusterlessProposal  [§5.2]
                           ├─ fold   → fold_markdown_proposal job
                           ├─ defer  → enqueuePublicationAction(publish)
                           └─ open   → enqueuePublicationAction(publish)
                                └─ flow outbox drains → publish_proposal → branch + PR  [§5.3]
```
