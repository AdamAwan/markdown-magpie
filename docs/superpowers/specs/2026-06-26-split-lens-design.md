# Split lens (fix-patrol) design

> **Status:** Approved for implementation - **Date:** 2026-06-26 - **Author:** Adam (with Codex)

The split lens is the third fix-patrol lens in the maintenance redesign. It catches
knowledge-base documents that have grown beyond one responsibility and turns that
finding into a bounded file-set Proposal. It reuses the infrastructure shipped for
dedupe: optional `Proposal.changeset`, `proposalTargets`, changeset-aware
`publish_proposal`, and `fold_changeset_proposal`.

## 1. Goals

- Split only documents that are likely to have outgrown their responsibility.
- Avoid creating more duplicate documents by giving the model a small neighbourhood
  of plausible existing homes.
- Publish split work through the same clusterless Proposal flow as verify and dedupe:
  AI job -> draft Proposal with `flowId` and `jobId` -> reconcile gate -> publish or
  multi-file fold.
- Keep the work bounded to one patrolled document plus a few neighbours, never a
  whole-KB crunch pass.

## 2. Trigger and pre-filter

`runFixPatrol` continues selecting the rolling cursor batch. The split lens runs over
that selected batch after verify and dedupe.

Before enqueuing AI work, the API applies a cheap local pre-filter. A document qualifies
for a split scan when either condition is true:

- `content.length > 15_000`
- it has at least `6` level-two Markdown headings (`## ...`)

This higher bar keeps split conservative and prevents it becoming an editorial
rearrangement pass over focused documents.

## 3. Neighbour retrieval

For each qualifying document, the lens retrieves possible destination/home documents
from the existing knowledge index. This is similar to dedupe neighbour lookup, but with
split-specific constants:

- relevance threshold: `0.55`
- hard cap: `5` documents

The lower threshold is deliberate. Dedupe looks for near-duplicates; split looks for
existing homes for extracted responsibilities, which may be related without being
nearly identical. The lookup still excludes the source document, folds ranked sections
to best-matching documents, sorts by relevance descending, and resolves full document
content for the AI job.

## 4. AI job contract

Add a provider-routed `split_document` job.

Input:

```ts
interface SplitDocumentJobInput {
  path: string;
  content: string;
  neighbours: Array<{ path: string; content: string }>;
  destinationId?: string;
  flowId?: string;
}
```

Output:

```ts
interface SplitDocumentJobOutput {
  split: boolean;
  rationale: string;
  primaryPath?: string;
  changeset?: ChangesetChange[];
}
```

Prompt behaviour is conservative:

- Return `split:false` when the document is long but cohesive, or when the
  responsibilities cannot be cleanly separated.
- When acting, keep `primaryPath` as the original patrolled document path.
- The changeset must include a write for `primaryPath`; that write is the parent or
  overview document.
- The model may create new focused docs.
- The model may rewrite neighbour docs to absorb moved material.
- The model may delete a touched existing document only when the split makes it
  genuinely redundant or effectively empty.
- Existing touched paths must be limited to the source document plus supplied
  neighbours. New paths are allowed only for newly-created docs.
- Preserve all existing information and do not invent facts.

## 5. Lens flow

Add `runSplitLens` in `apps/api/src/scheduling/split-lens.ts`.

For each selected document:

1. Apply the local pre-filter.
2. If it does not qualify, skip silently.
3. Resolve split neighbours with the split-specific threshold/cap.
4. Enqueue one `split_document` job carrying the document, neighbours,
   `destinationId`, and `flowId`.
5. Continue after per-document failures; one bad document must not abort the patrol tick.

The patrol service adds a `splitDocument` dependency beside `verifyDocument`,
`correctDocument`, and `dedupeDocument`. The default implementation enqueues
`split_document` with the configured provider.

## 6. Proposal creation

Add `createSplitProposalFromCompletedJob` in `apps/api/src/features/proposals/service.ts`.

On `split_document` completion:

- If `split` is false, return `undefined`.
- If `changeset` or `primaryPath` is missing, return `undefined`.
- If `primaryPath` differs from the job input `path`, return `undefined`.
- If the changeset has no concrete write for `primaryPath`, return `undefined`.
- If an existing touched path is outside `{input.path} + neighbours`, return `undefined`.
- Create a draft Proposal with:
  - title: `Split: reorganise <primaryPath>`
  - targetPath: `primaryPath`
  - markdown: the primary write content
  - changeset: the output changeset
  - rationale: output rationale
  - evidence: `[]`
  - flowId and destinationId from the job input
  - jobId for idempotency

New paths are allowed when they are not equal to any supplied existing path. The prompt
asks for sibling kebab-case `.md` paths; enforcement can stay prompt-level for the first
increment unless tests reveal a cheap validation helper is needed.

## 7. Reconcile and fold

Add `reconcileSplitProposal` in `apps/api/src/scheduling/fold.ts`.

It mirrors `reconcileDedupeProposal`:

- Build a `ChangeIntent` with `lens: "split"` and `targets: proposalTargets(proposal)`.
- Compare only same-flow open proposals.
- `open-new`: enqueue the split proposal for publication.
- `fold`: enqueue `fold_changeset_proposal` with survivor/rival changesets and
  `sharedPaths`.
- `defer`: self-publish the split proposal, preserving the existing approved-PR guard
  and relying on the cross-link backstop for overlap visibility.

The existing `applyChangesetFoldFromCompletedJob` remains the fold application path.
No new fold job type is needed.

## 8. Publication

No new publication path is needed. Split proposals are changeset Proposals, so
`publish_proposal` already publishes them through `publishChangeset`.

The PR title derives from the Proposal title, for example:

```text
docs: Split: reorganise kb/refunds.md
```

## 9. Testing

Focused tests:

- `packages/core`: `SplitDocumentJobInput` / `SplitDocumentJobOutput` types compile.
- `packages/jobs`: `split_document` schema, catalog expiry, and provider queue routing.
- `packages/prompts`: prompt count/order includes `split-document`.
- `apps/watcher`: `job-prompts.ts` routes `split_document` to `SPLIT_DOCUMENT`.
- `apps/api/src/scheduling/split-neighbours.test.ts`: threshold, cap, self-exclusion,
  section-to-document folding.
- `apps/api/src/scheduling/split-lens.test.ts`: pre-filter skips small docs, enqueues
  qualifying docs, carries neighbours, flowId, and destinationId, and survives per-doc
  failures.
- `apps/api/src/features/patrol/service.test.ts`: fix-patrol runs split over the selected
  batch without disturbing verify/dedupe behaviour.
- `apps/api/src/features/proposals/service.test.ts`: split completion drafts a changeset
  Proposal, no-ops on `split:false`, rejects malformed primary writes or out-of-scope
  existing paths, and is idempotent on `jobId`.
- `apps/api/src/scheduling/fold.test.ts`: `reconcileSplitProposal` open-new/defer/fold
  behaviour matches dedupe.
- `apps/api/src/features/jobs/service.test.ts`: completing `split_document` drafts and
  gates the split Proposal.
- `apps/api/src/app.test.ts`: `/api/prompts` count increments.

Pre-PR gates remain:

```bash
npm test
npm run typecheck
npm run deadcode
```

## 10. Out of scope

- Retiring crunch.
- Source-sync Scope B.
- Complete/improve patrol.
- Last-verified write-back.
- Whole-KB split analysis.
