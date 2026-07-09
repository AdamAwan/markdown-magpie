# Claim Provenance Phase 3 — Rewrite Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The jobs that rewrite document markdown stop being provenance-blind: `correct_document` and `improve_document` declare the claims their own diff introduces or changes (same per-output obligation as `mapUpdates`), so their PRs and proposal rows are provenance events too; `fold_markdown_proposal` merges the two parents' provenance onto the survivor instead of silently dropping the rival's. This closes the "newest blame hop points at a provenance-less PR" gap for agent-authored rewrites.

**Architecture:** Pure contract-and-prompt work plus two persistence touchpoints. The corrective/improve completion handlers currently persist `evidence: []` and no provenance — they gain `provenance` passthrough from the parsed output. Fold needs one new store method (`setProvenance`) because `applyFoldFromCompletedJob` only writes `markdown`/`changeset` today. Dedupe/split changesets stay out of scope as a documented limitation: their PRs state that content moved, and the pre-move events remain the trace.

**Tech Stack:** TypeScript ESM/NodeNext, node:test, zod.

**Spec:** `docs/superpowers/specs/2026-07-08-claim-provenance-design.md`. **Depends on phase 1** (contract + column + `warnMissingProvenance`); independent of phase 2. Branch: `claude/claim-provenance-rewrites` (main is PR-protected — never push main). Issue: #214.

## Global Constraints

- Same repo non-negotiables as phase 1 (queue-only, no `unknown` casts, `.js` import extensions, validate as you go, commit/push often, per-workspace test commands).
- Broker gotcha: every new output field goes on the zod schema in `@magpie/jobs` first.
- `provenance` stays optional on every contract: a rewrite that omits it warns (`warnMissingProvenance`, phase 1) and proceeds. `improve_document` with `improved: false` and a fold that returns no provenance must NOT warn as missing-provenance drafts — there is no new content to ground (fold falls back to concatenation instead, Task 4).
- Rationale-citation instructions move to structured provenance; the grounding contract ("files you actually read") is untouched.
- No new migrations — phase 1's `provenance` column serves all proposal kinds.

---

### Task 1: Contracts — `provenance` on correct/improve outputs

**Files:**
- Modify: `packages/core/src/index.ts` (`CorrectDocumentJobOutput` lines 718–722, `ImproveDocumentJobOutput` lines 773–778)
- Modify: `packages/jobs/src/schemas.ts` (`correctDocumentOutputSchema` lines 389–393; `improveDocumentOutputSchema` union lines 439–442 — the field goes on **both** union branches? No: only the branches that carry content — `improved: true` always, and the `improved: false` branch NOT at all, since it produces no new claims)
- Test: `packages/jobs/src/schemas.test.ts`

- [x] **Step 1: Failing tests**
  1. `correctDocumentOutputSchema` round-trips `provenance` (broker-strip protection; reuse the phase-1 test fixture shape).
  2. `improveDocumentOutputSchema` accepts `provenance` on the `improved: true` branch and rejects it on the `improved: false` branch (zod strict objects strip rather than reject — assert whichever the file's existing union tests assert for extra fields; if the schemas are non-strict, assert it parses but is absent from the false-branch type instead. Match the existing `mapUpdates`-on-union test at lines ~179–225).

- [x] **Step 2: Implement** — add `provenance: provenanceField` (the phase-1 shared field) to `correctDocumentOutputSchema` and to the `improved: true` branch; mirror on the core interfaces (`ImproveDocumentJobOutput` is a union type in core — put the field on the improved variant).

- [x] **Step 3: Validate and commit** — `npm test -w @magpie/jobs && npm run typecheck`; commit `feat(jobs): provenance on correct/improve outputs (#214)`; push `-u origin claude/claim-provenance-rewrites`.

---

### Task 2: Prompts — structured provenance replaces rationale citations

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (`CORRECT_DOCUMENT` lines 382–417, `IMPROVE_DOCUMENT` lines 486–524)
- Test: `packages/prompts/src/catalog.test.ts`

- [x] **Step 1: Failing tests** — mirror the phase-1 draft-prompt test: both ids instruct `"provenance"`, neither instructs citing paths **in the rationale**, both outputShapes mention provenance.

- [x] **Step 2: Implement**

`CORRECT_DOCUMENT`: replace the grounding bullet's "and cite their repository paths in the rationale" (line 397) with "report each corrected or rewritten claim in the "provenance" array of your JSON output (claim, section anchor, and the source files that ground the corrected wording)". Extend the Return-JSON block (409–416) with the provenance line (phase-1 shape). The body-cleanliness rule from phase 1's Task 7 already lives in this prompt — leave it.

`IMPROVE_DOCUMENT`: same treatment for the grounding line (500) and the rationale rule (513 — "which repository paths support it" becomes "per-claim support goes in \"provenance\""); provenance only applies when `improved` is true — say so explicitly ("when improved is false, omit provenance"). Extend the Return-JSON block (515–523).

- [x] **Step 3: Validate and commit** — `npm test -w @magpie/prompts`; commit `feat(prompts): correct/improve emit structured provenance (#214)`; push.

---

### Task 3: Completion handlers persist rewrite provenance

**Files:**
- Modify: `apps/api/src/features/proposals/service.ts` (`createCorrectiveProposalFromCompletedJob` lines 1421–1452, `createImproveProposalFromCompletedJob` lines 1599–1630)
- Test: `apps/api/src/features/proposals/service.test.ts`

- [x] **Step 1: Failing tests** (model on the existing corrective/improve tests at lines 1525/1707)
  1. Corrective proposal carries the correct job's `provenance`.
  2. Improve proposal (improved: true) carries it.
  3. `improved: false` output creates nothing and warns nothing (existing behaviour — regression guard only if not already covered).

- [x] **Step 2: Implement** — add `provenance: parsed.data.provenance,` to both `create` inputs; call `warnMissingProvenance` in both handlers (for improve, only on the `improved: true` path). `ProposalInput` already carries the field (phase 1).

- [x] **Step 3: Validate and commit** — `npm test -w @magpie/api`; commit `feat(api): rewrite proposals carry provenance (#214)`; push.

---

### Task 4: Fold merges provenance onto the survivor

**Files:**
- Modify: `packages/jobs/src/schemas.ts` (`foldMarkdownProposalInputSchema` lines 248–258, `foldMarkdownProposalOutputSchema` lines 259–262) + core `FoldMarkdownProposalJobInput`/`Output`
- Modify: `packages/prompts/src/catalog.ts` (the fold prompt — locate `fold` in the catalog; extend its rules + Return-JSON the same way)
- Modify: `apps/api/src/scheduling/fold.ts` (enqueue sites lines 53–63, 95–105, 273–283; `applyFoldFromCompletedJob` lines 296–364)
- Modify: `apps/api/src/stores/proposal-store.ts` + `postgres-proposal-store.ts` (new `setProvenance`)
- Test: `packages/jobs/src/schemas.test.ts`, `apps/api/src/scheduling/fold.test.ts` (or wherever `applyFoldFromCompletedJob` is covered — locate its existing tests first and extend in place), store tests

**Interfaces:**

```ts
// ProposalStore — fold rewrites the survivor's content, so its provenance
// event must be rewritten with it (the only post-create provenance write).
setProvenance(id: string, provenance: ProvenanceClaim[] | undefined): Promise<void>;
```

- [x] **Step 1: Failing tests**
  1. Schemas: fold input round-trips `survivorProvenance`/`rivalProvenance` (optional); output round-trips `provenance` (optional).
  2. Store: `setProvenance` round-trip on both stores (set, replace, clear with undefined → NULL).
  3. Fold apply: given survivor+rival proposals with provenance and a fold output carrying merged provenance, the survivor row ends with the output's provenance. Given a fold output WITHOUT provenance, the survivor ends with `[...survivor.provenance ?? [], ...rival.provenance ?? []]` (concat fallback) and a warn is logged. Given neither parent has provenance, no write and no warn.

- [x] **Step 2: Implement**

- Contracts: `survivorProvenance: provenanceField, rivalProvenance: provenanceField` on the fold input; `provenance: provenanceField` on the output.
- Enqueue sites (all three: `reconcileDraftedProposal`, `reconcileClusterlessProposal`, `reconcileImproveProposal`): pass `survivorProvenance: survivor.provenance, rivalProvenance: rival.provenance` (the second site names the rival `proposal` — read the code, don't pattern-match blindly).
- Fold prompt: instruct — "the two input documents come with their claim provenance; return the merged document's provenance: every claim surviving into the folded markdown keeps its sources, re-anchored to the folded document's headings".
- `applyFoldFromCompletedJob`, after the markdown/changeset write (lines 329–340):

```ts
const folded = parsed.data.provenance
  ?? concatParentProvenance(survivor, rival, job); // warns inside when falling back with parents present
if (folded && folded.length > 0) {
  await ctx.stores.proposals.setProvenance(survivor.id, folded);
}
```

Apply the same to `applyChangesetFoldFromCompletedJob` (lines 371–419).
- Postgres `setProvenance`: `UPDATE proposals SET provenance = $2 WHERE id = $1` with `JSON.stringify`/NULL binding (mirror the `updateReviewDecision` shape at lines 173–179).

- [x] **Step 3: Validate and commit** — `npm test -w @magpie/api -w @magpie/jobs && npm run test:db`; commit `feat(fold): survivor inherits merged claim provenance (#214)`; push.

---

### Task 5: Documented limitation + docs + full sweep

- [x] `dedupe_documents` / `split_document` changesets do **not** carry per-claim provenance in this phase. Document the limitation where the spec's phase-3 section already flags it, and in `docs/ai-jobs.md`: their PRs describe the move; `git blame` through the move reaches the pre-move provenance events; the phase-2 anchor-staleness guard makes verify re-derive for restructured sections. Revisit only if verify's fallback rate on moved documents proves noisy in practice.
- [x] Update `docs/ai-jobs.md` for the changed contracts; mark the spec's phase-3 status.
- [x] Full validation: `npm run build && npm run typecheck && npm run lint && npm test && npm run test:db`.
- [x] Commit `docs: claim provenance phase 3 (#214)`; push.

## Done when

- A corrective or improve PR's proposal row carries provenance from its own output (visible in the console per phase 1's UI, and in its PR body per phase 1's render — both come free once the rows carry the field).
- A fold demonstrably preserves rival provenance on the survivor (test 3 above).
- No prompt instructs rationale-citations anywhere in the catalog; all suites green.
