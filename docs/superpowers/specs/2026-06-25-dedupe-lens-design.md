# Dedupe lens (fix-patrol) — design

> **Status:** Approved · **Date:** 2026-06-25 · **Author:** Adam (with Claude)

The second fix-patrol lens. Where `verify` checks one file against its sources,
`dedupe` is the first **inherently cross-file** lens: it takes the file under patrol,
finds its *k* nearest neighbours via the existing KB search, and — when it finds a
genuine duplicate or contradiction — emits a **two-file** change that reconciles the
pair through the shared reconcile gate. See `docs/maintenance-redesign.md` §2/§4/§5.

This increment also builds the **file-set Proposal** infrastructure (a Proposal that
writes/deletes more than one document) that `split` will later reuse, and the
**multi-file fold** that lets such a proposal fold into an open PR on overlap.

---

## 1. Decisions taken (from brainstorming)

| Question | Decision |
| --- | --- |
| What does the PR write? | **True multi-doc change** — both docs (rewrite A, trim/delete B). |
| File-set size | **Pairwise (≤2)** — the AI picks the single best-matching neighbour. |
| Job shape | **Single `dedupe_documents` job** — detect + merge in one call. |
| Neighbour selection (k) | **Similarity threshold + hard cap** (`≥0.75`, `≤5`). Adaptive; silent on isolated docs. |
| Overlap with an open PR | **Build multi-file fold now** — a new `fold_changeset_proposal` job. |
| Proposal representation | **Additive optional `changeset`** on Proposal; absent ⇒ today's single-file behaviour. |

These reuse the patrol-proposal flow pattern shipped for verify: new AI job → draft
Proposal carrying `flowId` (idempotent on `jobId`) → dedicated reconcile fn in
`fold.ts` → clusterless proposal owns its publication (open-new/defer → outbox publish;
fold → fold job).

---

## 2. Data model & accessors

`Proposal` (packages/core/src/index.ts) gains one optional field after `markdown`:

```ts
// When present, this proposal writes/deletes multiple files and is the source of
// truth for both publication and gate overlap. When absent, the proposal is the
// single-file [{ path: targetPath, content: markdown }] it has always been.
// dedupe (and later split) set it; gap/verify/source-sync leave it undefined.
changeset?: ChangesetChange[];
```

`ChangesetChange` already exists: `{ path: string; content?: string; delete?: boolean }`.

**Invariant:** a changeset proposal still carries a sensible `targetPath` + `markdown` —
its *primary* doc (doc A, the survivor). Title, branch name, and PR body all derive
from the primary, so existing display/publish code keeps working. B's trim/delete lives
only in the changeset.

**Accessors** — new `apps/api/src/scheduling/changeset.ts`, so no call site hand-rolls
the "changeset-if-present" logic:

```ts
export function proposalChangeset(p: Proposal): ChangesetChange[] {
  return p.changeset ?? [{ path: p.targetPath, content: p.markdown }];
}
export function proposalTargets(p: Proposal): string[] {
  return proposalChangeset(p).map((c) => c.path);
}
```

**Stores:** `ProposalInput` gains `changeset?`. `InMemoryProposalStore.create` stores it.
Postgres adds a `jsonb` column `changeset` (migration **0030**,
`ADD COLUMN IF NOT EXISTS changeset jsonb`), serialised on insert, parsed in `mapRow`
(→ `undefined` when null). A new store method `updateChangeset(id, changeset, primaryMarkdown)`
sets the changeset and refreshes the primary `markdown` (used by the fold handler);
`targetPath` is never rewritten.

---

## 3. Neighbour retrieval (k-NN)

New `apps/api/src/scheduling/dedupe-neighbours.ts`, pure orchestration over the
existing hybrid `knowledgeIndex.search()` (keyword + pgvector):

```ts
const DEDUPE_SIMILARITY_THRESHOLD = 0.75; // "is anything actually close?" bar
const DEDUPE_MAX_NEIGHBOURS = 5;          // hard cap on per-scan cost

export async function dedupeNeighbours(
  ctx: AppContext,
  doc: { path: string; content: string },
  repositoryIds: string[] | undefined
): Promise<Array<{ path: string; content: string }>>;
```

`search()` returns ranked **sections**; we fold them to **documents** (max section
`relevance` per doc), drop the doc itself, keep those `≥ THRESHOLD`, sort by score
desc, cap at `MAX_NEIGHBOURS`, and resolve each to its full document content via the
index. Query text is the patrolled doc's own content. A doc with nothing above the bar
returns `[]` — the lens enqueues no job for it (natural silence on isolated docs).

---

## 4. The `dedupe_documents` job

A provider/AI job. Full registration (mirrors `verify_document`/`correct_document`):
`JOB_TYPES`, `define()` + `aiJobTypes` set, `EXPIRATION_SECONDS` `10*60` + a routing test
in `catalog.test.ts`, input/output Zod schemas, core types, a `job-prompts.ts` `buildPrompt`
case, and a `dedupe-documents` prompt in the catalog (count + order assertions, and the
`/api/prompts` count in `app.test.ts`).

**Core types:**

```ts
export interface DedupeDocumentsJobInput {
  path: string; content: string;                        // doc A, under patrol
  neighbours: Array<{ path: string; content: string }>; // ≤5, pre-filtered
  destinationId?: string; flowId?: string;
}
export interface DedupeDocumentsJobOutput {
  duplicate: boolean;             // conservatism: false unless a real duplicate/contradiction
  rationale: string;
  primaryPath?: string;           // when duplicate: which doc is the survivor (A)
  changeset?: ChangesetChange[];  // when duplicate: the pairwise file-set (rewrite A; trim/delete B)
}
```

**Prompt** (`dedupe-documents`): conservative. Act only on a *genuine* duplicate or
contradiction between A and exactly one neighbour; otherwise return `duplicate:false`.
When acting, produce a minimal 2-file changeset that leaves both docs coherent: rewrite
the survivor to hold every unique fact from both, then **delete B by default** once the
survivor has absorbed its content. Keep B (trimmed, with a cross-reference) only when it
retains substantive material of its own; never leave a pointer-only stub ("moved to …",
"see <survivor>") — that must be deleted instead. Changeset paths are always a subset of
`{A} ∪ neighbours`. `primaryPath` is A (the patrolled doc) unless the model judges the
neighbour the better survivor.

---

## 5. Lens, fix-patrol wiring, completion handler

Enqueue-only end to end (ticks stay cheap; AI work + proposal creation happen async).

**`runDedupeLens`** (new `apps/api/src/scheduling/dedupe-lens.ts`):

```ts
export type DedupeDocumentFn = (ctx: AppContext, input: DedupeDocumentsJobInput) => Promise<void>;
// For each selected doc: find neighbours (mechanical, in-tick). If any clear the bar,
// enqueue ONE dedupe_documents job carrying them. No neighbours → skip. Returns the
// number of scans enqueued.
export async function runDedupeLens(
  ctx: AppContext,
  input: {
    flowId: string | undefined;
    documents: Array<{ path: string; content: string }>;
    repositoryIds: string[] | undefined;
    dedupeDocument: DedupeDocumentFn;
  }
): Promise<number>;
```

**`defaultDedupeDocument`** (patrol/service.ts): enqueues `dedupe_documents` with the
configured `provider`, exactly like `defaultCorrectDocument`.

**`runFixPatrol`** runs both lenses over the *same* selected batch. After the verify
finding loop it calls `runDedupeLens` over `selectedDocuments` with
`repositoryIds = scope.repositoryIds`. `deps` gains `dedupeDocument?`. The run log gains
`… N dedupe scan(s) enqueued`. (The existing verify tests pass `correctDocument: async () => {}`;
the dedupe-quiet equivalent is `dedupeDocument: async () => {}`.)

**`createDedupeProposalFromCompletedJob`** (proposals/service.ts), wired into
`completeJob`'s fixed sequence right after `createCorrectiveProposalFromCompletedJob`:

- guard `job.type === "dedupe_documents"`; parse output; if `!duplicate` → **no-op** (silent).
- else create a draft Proposal: `changeset = output.changeset`,
  `targetPath = output.primaryPath`, `markdown =` the changeset write for `primaryPath`,
  `title = "Dedupe: reconcile <A> with <B>"`, `flowId`, `destinationId`, `jobId` (idempotent),
  `evidence: []`.
- then best-effort `reconcileDedupeProposal(ctx, proposal)` (try/catch warn).

**`reconcileDedupeProposal`** (scheduling/fold.ts): same structure as
`reconcileCorrectiveProposal`, gating on the **multi-target** file-set
(`intent.targets = proposalTargets(proposal)`, `lens: "dedupe"`). A `fold` verdict enqueues
`fold_changeset_proposal`; open-new/defer self-publish via `enqueuePublicationAction`.

---

## 6. Multi-file fold (`fold_changeset_proposal`)

A provider/AI job, registered like `fold_markdown_proposal` (incl. its own
`fold-changeset-proposal` prompt). Across this increment prompts go **14→16**
(`dedupe-documents` + `fold-changeset-proposal`); `/api/prompts` likewise; `JOB_TYPES`
gains both new types.

**Enqueue** (from `reconcileDedupeProposal`'s `fold` verdict):

```ts
fold_changeset_proposal {
  provider,
  survivorProposalId, rivalProposalId,
  survivorChangeset: proposalChangeset(survivor),
  rivalChangeset: proposalChangeset(rival),
  sharedPaths: sharedTargets(proposalTargets(survivor), proposalTargets(rival)),
  expectedOutput: "folded_changeset"
}
```

**Output:** `{ changeset: ChangesetChange[]; rationale: string }`.

**Prompt** (`fold-changeset-proposal`): produce one unified changeset over the *union*
of both file-sets; on a shared path apply both edits coherently (model rewrites, never a
mechanical merge — §5 of the north star); carry non-shared paths through unchanged.

**`applyChangesetFoldFromCompletedJob`** (fold.ts, parallel to `applyFoldFromCompletedJob`),
in `completeJob`'s fixed sequence:

- guard type; parse; fetch survivor + rival; no-op if missing or rival already `superseded`
  (idempotent).
- **promote the survivor** to the merged file-set via `updateChangeset(survivor.id, merged,
  primaryMarkdown)`; `targetPath` stays. A previously single-file survivor thereby gains
  B's trim/delete.
- supersede rival; re-publish survivor via `enqueuePublicationAction(survivor.id, "publish")`;
  comment the fold note on the survivor PR if it has a `pullRequestUrl`. (Dedupe proposals
  are clusterless, so the gap-cluster absorption branch of the single-file fold is skipped.)

**Fallback:** generalise `enqueueFoldFallback` to also accept `fold_changeset_proposal`
(its body only re-publishes the rival, so it is type-agnostic once the guard widens) — a
failed merge never loses the dedupe change.

---

## 7. Publication & gate

**Publication** — keep the single `publish_proposal` job; teach it the changeset case:

- API `proposalExecutionContext` includes `proposal.changeset` when present.
- Watcher `proposalSchema` gains optional `changeset: z.array(changesetChangeSchema)`.
  In `publishProposal()`: branch/title/PR-raise unchanged (all derive from the primary);
  if `proposal.changeset` is present → publish via the existing `deps.publishChangeset({ …,
  changes: changeset })`, else the single-file `deps.publishProposal` as today.
- `WatcherApi.proposalExecutionContext`'s return type gains `changeset?` — **optional**, so
  existing test stubs that omit it still typecheck.

**Gate multi-target** — `openPullRequestSummaries` (reconcile-gate.ts) sets
`targets: proposalTargets(proposal)` instead of `[proposal.targetPath]`. An open dedupe PR
on `[A, B]` now exposes both paths, so a later intent touching B detects the overlap.
Single-file proposals are unaffected.

**Labelling** — dedupe proposals get the `"Dedupe: …"` title prefix, so the PR is
`docs: Dedupe: reconcile A with B`. Same mechanism verify uses; no watcher change.

---

## 8. Errors & edge cases

- **No neighbours / nothing above threshold** → no job enqueued; doc stays silent.
- **`duplicate:false`** → completion handler no-ops; no proposal.
- **`primaryPath` not in the changeset** (malformed output) → handler logs and skips
  (no proposal), like verify's malformed-output guard.
- **Vector search unavailable** → `search()` already degrades to keyword ranking; dedupe
  still runs on keyword neighbours.
- **Fold survivor vanished between gate and fetch** → `reconcileDedupeProposal` falls
  through to self-publish (same as `reconcileCorrectiveProposal`).
- **Fold job fails terminally** → `enqueueFoldFallback` publishes the rival as its own PR.
- **Idempotency** → proposal creation de-dupes on `jobId`; fold application no-ops on an
  already-superseded rival.

---

## 9. Testing

- `changeset.ts`: `proposalChangeset`/`proposalTargets` for single-file and changeset proposals.
- `dedupe-neighbours.ts`: threshold filtering, self-exclusion, cap, empty result, section→doc folding.
- `catalog.test.ts`: `dedupe_documents` and `fold_changeset_proposal` route by provider; expiry entries.
- prompts `catalog.test.ts`: count 14→16, order includes both new prompts.
- core/jobs schema round-trips for both new job contracts.
- `dedupe-lens.test.ts`: enqueues a job per doc-with-neighbours; skips doc-without; quiet fn no-ops.
- proposals `service.test.ts`: `createDedupeProposalFromCompletedJob` — duplicate→changeset proposal,
  `!duplicate`→none, malformed→none, idempotent on jobId.
- fold `service.test.ts`: `reconcileDedupeProposal` open-new/defer→publish, fold→`fold_changeset_proposal`;
  `applyChangesetFoldFromCompletedJob` promotes survivor + supersedes rival + republishes; fallback.
- reconcile-gate `test`: `openPullRequestSummaries` reports all changeset paths.
- patrol `service.test.ts`: `runFixPatrol` runs dedupe over the batch (spy) without disturbing verify.
- watcher publication test: `publish_proposal` with a changeset calls `publishChangeset`, single-file
  still calls `publishProposal`.
- `app.test.ts`: `/api/prompts` count 14→16.

Pre-PR gates: `npm test`, `npm run typecheck`, `npm run deadcode` (knip strict — de-export,
never relax).

---

## 10. End-to-end flow

1. fix-patrol tick selects a batch (oldest-N + random).
2. For each doc, `dedupeNeighbours` retrieves ≤5 docs above the similarity bar.
3. Docs with neighbours enqueue a `dedupe_documents` job (enqueue-only).
4. Watcher runs the job → `{ duplicate, changeset, primaryPath, rationale }`.
5. `completeJob` → `createDedupeProposalFromCompletedJob`: on `duplicate`, a draft
   file-set Proposal carrying `flowId` + `changeset`.
6. `reconcileDedupeProposal` gates on the 2-path file-set:
   - no overlap → `enqueuePublicationAction(publish)`.
   - touchable overlap → `fold_changeset_proposal` → survivor promoted to the merged
     file-set, rival superseded, survivor re-published.
   - locked (approved) overlap → defer → self-publish (cross-link backstop flags it).
7. `publish_proposal` publishes the changeset via `publishChangeset` and opens a
   `docs: Dedupe: …` PR. Human reviews and merges.
