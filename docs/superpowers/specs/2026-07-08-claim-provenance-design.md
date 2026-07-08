# Per-claim source provenance as an append-only event log — design

Date: 2026-07-08
Status: draft
Issue: #214 (direction agreed in the issue thread, 2026-07-08 comment)

## Problem

"Why does the knowledge base believe this claim?" is currently answered in two
places, and both are wrong:

- **Inline in the markdown body.** `DRAFT_MARKDOWN_PROPOSAL` and
  `DRAFT_SEED_DOCUMENT` (`packages/prompts/src/catalog.ts:148`, `:191`) instruct
  the agent to cite repository paths in the text, e.g.
  `(see Docs/Specifications/Statements/ingestion.md)`. Because `answer_question`
  builds answers directly from retrieved document sections, these internal source
  paths **leak into answers served to end users**.
- **In the proposal `rationale`** — one free-text paragraph. Not per-claim, so it
  cannot answer "which source supports *this* statement?", and it is proposal
  metadata that does not live on with the published document.

The verify patrol (`verify_document`) is the main automated consumer of
provenance and today has none: it re-derives from scratch which sources should
support a document on every tick.

## Decision: provenance is an append-only event log, not a living map

Each publication carries the proof for **its own diff**; the historical sequence
of publications is the provenance record. Semantics: *"what supported this
change when it shipped"*, not *"what currently supports this document"*. A log
never goes stale, so no maintenance pass over old documents is ever required.

Two surfaces, one record:

- **Human-facing — the PR and git history.** The PR body renders the per-claim
  provenance map. After merge it is permanently findable:
  `git blame` the line → commit → PR → that PR's provenance section. Published
  documents stay completely clean, which fixes the answer-path leak **by
  construction** — there is nothing to strip.
- **Machine-facing — the proposals table.** The same structured provenance is
  persisted on the proposal row (`provenance jsonb`, the `draft_context`
  precedent from migration 0020). Pre-merge, the proposal UI reads it. Post-merge
  (`merged_at` set), the row **is** the provenance event for its `target_path`.
  The API answers "what supports this claim?" and feeds `verify_document` by
  folding the merged-proposal log for a document path — no blame walks, no
  GitHub API archaeology.

### Rejected alternatives

- **Frontmatter / sidecar on the published document** (the issue's original
  sketch). Five jobs rewrite document markdown (`correct_document`,
  `improve_document`, `fold_markdown_proposal`, `dedupe_documents`,
  `split_document`) and humans edit documents directly; every rewrite
  invalidates a claim-keyed map attached to the document. A document-attached
  map therefore requires a perpetual maintenance pass or becomes confidently
  stale — worse than no provenance for the verify patrol. It also bloats the
  document, invites merge conflicts, and (frontmatter variant) depends on the
  answer path stripping correctly everywhere, forever.
- **PR body as the only record.** Three holes: local-git flows
  (`flowPublishMode` → `local-git`) have **no PRs at all**; the API holds no
  GitHub token (PR access is watcher-side by design), so machine lookups become
  queue traffic; and blame→PR walks are brittle across squash merges and the
  content moves that dedupe/split changesets perform. Hence the DB event log as
  the machine index alongside it.
- **Git notes** (`refs/notes`). Machine-readable and out-of-tree, but not pushed
  by default, invisible on GitHub, and orphaned by squash merges.

## Data model

New shared type in `@magpie/core`, mirrored as a zod schema in `@magpie/jobs`
(the broker strips fields not declared on the output schema — same gotcha
documented for `mapUpdates` and `uncoveredPoints`):

```ts
// One substantive claim in the drafted markdown and the source locations that
// ground it. `sourceId` references a SourceDescriptor id from the job input;
// `path` is repo-relative within that source. `anchor` is the slug of the
// section heading the claim lives under — used for display grouping and as a
// soft key for later staleness checks; claims are NOT keyed by exact body text.
export interface ProvenanceClaim {
  claim: string;            // short restatement of the claim, not a body quote
  anchor?: string;          // section heading slug in the drafted markdown
  sources: Array<{
    sourceId: string;       // SourceDescriptor.id from the job input
    path?: string;          // repo-relative file path (git/local sources)
    lines?: string;         // optional "L12-L40" hint
    url?: string;           // internet sources
  }>;
}
```

Reference-only sources (`internet`, `agent`) are allowed in `sources` — they
ground a claim as supporting context, matching how the drafting prompts already
treat them.

### Persistence

- Migration `0049_proposal_provenance.sql`:
  `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS provenance jsonb;`
  Nullable — proposals drafted before this feature (and drafts that omit the
  field) have no provenance, exactly like `draft_context`.
- `Proposal` (core) gains `provenance?: ProvenanceClaim[]`; the proposal stores
  (`postgres-proposal-store.ts`, in-memory store) and the API serialization
  carry it through. The web console gets it for free from the proposal payload.

### Event-log fold (machine reads)

"Current provenance for document `path`" = merged proposals with
`target_path = path` (and changeset entries touching `path`), ordered by
`merged_at`; later events supersede earlier ones **per claim anchor**, and the
fold is advisory, not authoritative: consumers must tolerate gaps (human edits,
pre-feature proposals). Implemented as a small query + pure fold function in the
proposals feature; exposed to the patrol service (phase 2) and, later, a
`GET /api/documents/provenance?path=…` style endpoint if the console needs a
document-centric view (not in scope for phase 1).

## Job contract changes

Phase 1 (draft jobs):

- `draftMarkdownProposalOutputSchema` and `draftSeedDocumentOutputSchema` gain
  `provenance: z.array(provenanceClaimSchema).optional()`.
- The completion handler in `apps/api/src/features/proposals/service.ts`
  persists it onto the proposal. A draft that omits or empties the field gets a
  `logger.warn` (mirroring `foldUncoveredPointsIntoRationale`'s
  operator-visibility approach) but still publishes — provenance quality is
  enforced by review and the verify patrol, not by rejecting drafts.

Phase 2 (verify consumption):

- `verifyDocumentInputSchema` gains
  `citedClaims: z.array(provenanceClaimSchema).optional()`. The patrol service
  populates it from the event-log fold. The verify prompt is extended: check
  each cited claim against its cited location **first**; a claim whose cited
  support no longer exists or no longer says what the claim says is reported in
  `claims` with a reason distinguishing "cited support changed/gone" from
  "never provable". Claims with no provenance entry fall back to today's
  re-derivation. `citedClaims` is advisory input — the agent still explores the
  source checkouts as it does now.

Phase 3 (rewrite jobs document their own diffs):

- `correctDocumentOutputSchema` and `improveDocumentOutputSchema` gain the same
  optional `provenance` field, covering the claims their diff introduces or
  materially changes (same per-output obligation pattern as `mapUpdates`).
  Their completion handlers persist it on the corrective/improvement proposal,
  so those PRs and proposal rows are provenance events too.
- `fold_markdown_proposal`: the survivor proposal's provenance is replaced by
  the union of both parents' claims re-attributed by the folded output; if the
  fold output cannot provide this, fall back to concatenating both parents'
  provenance with a `logger.warn`. Dedupe/split changesets carry provenance per
  changeset entry only if cheap; otherwise their PRs state "content moved from
  X" and the pre-move events remain the trace (documented limitation).

## Prompt changes (`packages/prompts/src/catalog.ts`)

- `DRAFT_MARKDOWN_PROPOSAL` (line ~191) and `DRAFT_SEED_DOCUMENT` (line ~148):
  **remove** the instruction to cite repository paths inline in the text.
  Replace with: the document body must contain **no** repository paths, file
  references, or source names; every substantive claim must instead appear in
  the `provenance` array of the JSON output, citing the files actually read
  (`sourceId` + repo-relative path). Grounding requirements are unchanged —
  only where the citations go changes.
- The existing "cite … in the rationale" instructions for correct (line ~397)
  and improve (line ~500) move to structured `provenance` in phase 3; until
  then they stay as-is (rationale citations don't leak — rationale is never
  document content).
- Prompt catalog tests updated alongside (`catalog.test.ts` asserts on
  instruction text).

## Review surfaces

- **PR body.** `buildPullRequestBody` in
  `apps/watcher/src/runners/publication.ts:349` is now the **only** render site
  — the "mirroring the API's buildPullRequestBody" comment at line 348 is
  stale (the API copy no longer exists) and gets fixed in passing. The publish
  payload's `proposalSchema` (publication.ts:119) gains optional `provenance`,
  the API's publish-job enqueue includes it, and the body renders a
  `### Claim provenance` section: one line per claim,
  `— <claim> ⇐ <source name>: <path>[ <lines>]`, grouped by `anchor` when
  present. Absent/empty provenance renders nothing (older proposals keep
  today's body).
- **Proposal UI.** The proposal detail view in `apps/web` renders the
  provenance list alongside the drafted markdown (grouped by anchor), using the
  existing UI primitives (`Surface`, `Badge`, `Stack`); data arrives on the
  proposal payload, no new endpoint. Absent provenance → section not shown.
- **Local-git flows.** No PR exists, but the proposal row carries provenance,
  so the console's Accept/Bin review view shows the same information — the
  console *is* the review surface for those flows.

## Answer path and cleanup

No strip pipeline is needed going forward — provenance never enters document
bodies. Existing published documents may still carry inline `(see …)` citations
from the old prompts. Cleanup: a **one-off, operator-triggered sweep** — scan
each flow destination's checkout for inline citation patterns
(`\(see [^)]*\.md[^)]*\)` and the surrounding sentence), and enqueue a
`correct_document`-shaped rewrite per affected doc with claims of the form
"remove inline repository-path citation; content otherwise unchanged". Runs
through the normal proposal→review→PR path (no silent mass edit). Ships with
phase 1; documented in `docs/`, not scheduled — run once per deployment and
retire.

## Failure semantics

- **Draft omits provenance:** warn, publish anyway (see above). The field is
  optional end-to-end; nothing hard-fails on its absence.
- **Hallucinated citations:** expected occasionally; this is precisely what
  phase 2's verify check catches (cited file missing / doesn't support claim →
  flagged). Phase 1 relies on the human reviewer, who now sees claims and
  sources side by side in the PR.
- **Human direct edits:** produce no provenance event, deliberately. Blame
  shows a human commit; the verify patrol falls back to full re-derivation for
  claims the fold can't attribute — today's behaviour, now scoped to the gaps.
- **Stale fold vs. document content:** before passing `citedClaims` to verify,
  the patrol drops claims whose `anchor` no longer exists in the current
  document content (cheap heading check) — those fall back to re-derivation
  rather than producing false "cited support changed" verdicts.

## Phasing

1. **Phase 1 — capture + review surfaces (fixes the leak).** Core type, jobs
   schemas, migration 0049, prompt edits for the two draft jobs, completion
   handler persistence, publish payload + PR body render, proposal UI,
   cleanup-sweep script + doc. Independently shippable and valuable.
2. **Phase 2 — verify consumption.** Event-log fold, `citedClaims` on the
   verify contract, prompt extension, staleness guard.
3. **Phase 3 — rewrite jobs.** `provenance` on correct/improve outputs, prompt
   moves from rationale-citations to structured, fold/dedupe/split handling.

Each phase is one PR-sized unit; later phases degrade gracefully if never
shipped (the log just has fewer event types).

## Testing

- `packages/jobs`: schema round-trips incl. broker-strip protection (the
  existing `mapUpdates` test pattern at `schemas.test.ts:221`).
- `apps/api` proposals service: completion handler persists provenance; warn on
  absence; event-log fold unit tests (supersession per anchor, changeset paths,
  gap tolerance).
- `apps/watcher` publication: PR body render with/without provenance/anchors.
- Migration: per the write-a-migration skill (prefix-uniqueness guard, applied
  in the Postgres-backed harness).
- Prompt catalog tests: no inline-citation instruction remains in the two draft
  prompts; provenance instruction present.

## Out of scope

- Fabricating gap rows or demand from provenance (same reasoning as #213's
  `uncoveredPoints` decision — product call, demand stays question-driven).
- Provenance for human edits (no authoring surface to capture it).
- A document-centric provenance API/console view (add later if the fold proves
  useful beyond the patrol).
- Retrofitting provenance onto pre-feature merged proposals.
