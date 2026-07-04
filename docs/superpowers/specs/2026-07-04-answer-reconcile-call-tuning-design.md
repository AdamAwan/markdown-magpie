# Answer/reconcile call-count tuning (issue #169, Parts 1 + 2)

**Status:** approved · **Date:** 2026-07-04 · **Issue:** #169 (`token-efficiency`)

Two independent per-call token savings on the hot answering and gap-reconcile paths.
Both are confined to `apps/watcher/src/runners/generative.ts` and the shared prompt
catalog (`packages/prompts/src/catalog.ts`). No API, retrieval, schema, or migration
changes. Part 3 of the issue (embeddings-based flow routing) is explicitly **out of
scope** here.

## Part 1 — Grounding verify: full cited sections + heading-only uncited sections

### Today

`verifyAnswerGrounding` (generative.ts) runs a second provider call for every
medium/high-confidence answer and re-sends the **entire** retrieved pool (up to
`MAX_POOL_SECTIONS = 15` full section bodies) via `formatSectionContext` — the same
context already sent in the assess call. The whole pool (not just the cited subset) is
sent deliberately so a claim backed by a retrieved-but-uncited section is not falsely
flagged (documented at generative.ts:217-220).

### Change

Partition the pool with `output.citations` (each `Citation` has a `sectionId`):

- **Cited** sections → full body, unchanged: `[section <id>] # <heading>\n<body>`.
- **Uncited** sections → **heading/anchor line only**: `[section <id>] # <heading>`
  (no body), rendered under a labelled "also retrieved (headings only)" block.

`formatSectionContext` gains a headings-only rendering mode; `verifyAnswerGrounding`
partitions the pool and formats each group, cited block first.

### Tradeoff (accepted)

The verifier can no longer read the *body* of an uncited section, so it cannot
body-verify a claim grounded only there. To preserve the *intent* of the original
property, `VERIFY_ANSWER` is updated to state that heading-only sections were retrieved
as relevant, so a claim whose topic matches one of those headings should be treated as
plausibly grounded rather than flagged as fabricated. This keeps the "don't manufacture
false fabrication flags" behaviour while removing the bulk of the duplicated body
tokens. It is a deliberate semantic shift for the uncited tail (topical-heading-match
instead of body-verified) — the cost of the saving, and the approach the issue endorses.

## Part 2 — Reconcile critic: one batched call instead of M+S+D calls

### Today

`reconcileGapClusters` critic-confirms sequentially: separate loops over merges, splits,
and dismissals, each iteration a separate `criticConfirm` → `model.complete` carrying the
full `GAP_RECONCILE_CRITIC` system prompt. Total = `1 propose + M + S + D` calls.

### Change

One batched critic call. Build a single user message enumerating every proposed
operation with a stable id (`merge-0`, `split-1`, `dismissal-0`), each carrying its
rationale — and for dismissals the cluster summary line, preserving the current "critic
sees the same scope the proposer did" property. A reworked `GAP_RECONCILE_CRITIC` returns
`{"verdicts":[{"id":"merge-0","confirmed":true}, ...]}`.

Parse into a `Map<string, boolean>`; an operation is confirmed only when its id maps to
`confirmed:true`. Any missing, unparseable, extra, or reordered verdict defaults to
**not confirmed**, preserving today's conservative behaviour and the "unparseable ⇒ not
confirmed" guarantee.

**Short-circuit:** when the proposal has zero operations, skip the critic call entirely
(the loops already do not fire today — one propose call, no critic). Total drops from
`1 + M + S + D` to `1 + (1 if any ops else 0)`.

## Testing

- `apps/watcher/src/runners/chat.test.ts`
  - Update grounding-check assertions to the new context format (cited bodies + uncited
    headings only).
  - Add: a claim grounded only in an uncited section is not flagged (Part 1 property
    preserved).
  - Rework the two reconcile tests (`derives confirmed flags from the critic`,
    `unparseable critic ⇒ not confirmed`) to mock a single batched verdict response.
  - Add: a batched reconcile where the critic confirms some ops and rejects others,
    asserting exactly one critic call is made.
- `packages/prompts/src/catalog.test.ts` — adjust output-shape expectations for the two
  changed prompts.

## Validation

`npm run build && npm run typecheck && npm run lint`, plus
`npm test -w apps/watcher -w packages/prompts`, run per part. Each part committed and
pushed separately.
