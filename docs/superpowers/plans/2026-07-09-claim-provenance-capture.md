# Claim Provenance Phase 1 — Capture + Review Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drafts stop citing repository paths inline in the document body (the paths currently leak into user-facing answers via `answer_question`) and instead return a structured per-claim `provenance` array; the API persists it on the proposal; reviewers see it in the PR body and the web console's proposal view. Existing inline citations get cleaned up organically by the verify→correct patrol.

**Architecture:** `ProvenanceClaim` is a new `@magpie/core` type mirrored as a zod schema in `@magpie/jobs` (declared on the draft output contracts so the broker doesn't strip it — the `mapUpdates`/`uncoveredPoints` precedent). The proposals table gains a nullable `provenance jsonb` column (the `draft_context` 0020 precedent). No document-attached storage: documents stay clean, so nothing needs stripping on the answer path. The PR body render happens in the watcher's publication runner (the only render site); the web console reads the field off the proposal payload it already fetches.

**Tech Stack:** TypeScript ESM/NodeNext, node:test, zod, custom SQL migrator, Emotion CSS-in-JS (web).

**Spec:** `docs/superpowers/specs/2026-07-08-claim-provenance-design.md`. Branch: `claude/claim-provenance-capture` (main is PR-protected — never push main). Issue: #214.

## Global Constraints

- The API never calls a chat/generative provider inline; nothing in this plan touches providers directly.
- Never cast through `unknown`/`any` to silence types. No hacky workarounds.
- Relative imports need explicit `.js` extensions, even from `.ts`.
- Validate as you go: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint`. DB-backed tests: `npm run test:db`.
- Run tests per workspace (`npm test -w @magpie/api` style), never root-cwd `node --test`.
- Commit and push little and often (on the feature branch).
- Migrations: append-only, `NNNN_snake_case.sql`; next free prefix is **0049** at time of writing — re-check `ls packages/db/migrations | sort | tail -1` before creating.
- Broker gotcha: any new field on a job output MUST be declared on the zod output schema in `@magpie/jobs` or the broker strips it before the API's completion handler sees it (see the comments on `mapUpdates`/`uncoveredPoints` in `packages/jobs/src/schemas.ts`).
- `provenance` is optional end-to-end. A draft that omits it gets a `logger.warn` (operator visibility, the `foldUncoveredPointsIntoRationale` pattern) but still publishes — quality is enforced by review and (phase 2) the verify patrol, never by rejecting drafts.
- Prompt edits change WHERE citations go, not the grounding contract itself — every "ground in files you actually read" instruction stays.

---

### Task 1: Core type + jobs schema (`ProvenanceClaim`)

**Files:**
- Modify: `packages/core/src/index.ts` (new interfaces near `DraftContext` ~line 420; extend `DraftMarkdownProposalJobOutput` ~line 780, `DraftSeedDocumentJobOutput` ~line 859, `Proposal` ~line 359)
- Modify: `packages/jobs/src/schemas.ts` (new `provenanceClaimSchema` near `sourceMapUpdateSchema` ~line 148; extend the two draft output schemas at ~191 and ~212)
- Test: `packages/jobs/src/schemas.test.ts`

**Interfaces:**
- Produces (used by every later task):

```ts
// One substantive claim in a drafted document and the source locations that
// ground it. sourceId references a SourceDescriptor.id from the job input;
// path is repo-relative within that source. anchor is the slug of the section
// heading the claim lives under — a display-grouping and soft staleness key,
// NOT an exact-text key.
export interface ProvenanceClaimSource {
  sourceId: string;
  path?: string;   // git/local sources
  lines?: string;  // optional "L12-L40" hint
  url?: string;    // internet sources
}
export interface ProvenanceClaim {
  claim: string;   // short restatement, not a body quote
  anchor?: string;
  sources: ProvenanceClaimSource[];
}
```

- `DraftMarkdownProposalJobOutput` and `DraftSeedDocumentJobOutput` gain `provenance?: ProvenanceClaim[]`.
- `Proposal` gains `provenance?: ProvenanceClaim[]` (after `draftContext`, with a comment explaining the event-log semantics: on a merged proposal this row IS the provenance event for its targetPath).

- [ ] **Step 1: Write the failing schema tests**

Add to `packages/jobs/src/schemas.test.ts`, following the existing broker-strip test pattern (line ~221):

```ts
test("draft output schemas keep the provenance field (broker-strip protection)", () => {
  const provenance = [
    {
      claim: "Logs are retained for 12 months",
      anchor: "log-retention",
      sources: [{ sourceId: "src-1", path: "docs/ops/logging.md", lines: "L10-L14" }]
    }
  ];
  const base = { title: "t", targetPath: "p.md", markdown: "# d", rationale: "r" };
  for (const schema of [draftMarkdownProposalOutputSchema, draftSeedDocumentOutputSchema]) {
    const parsed = schema.safeParse({ ...base, provenance });
    assert.ok(parsed.success);
    assert.deepEqual(parsed.success ? parsed.data.provenance : undefined, provenance);
    assert.ok(schema.safeParse(base).success, "provenance stays optional");
  }
});

test("provenance rejects a claim without sources array", () => {
  const base = { title: "t", targetPath: "p.md", markdown: "# d", rationale: "r" };
  assert.ok(
    !draftMarkdownProposalOutputSchema.safeParse({
      ...base,
      provenance: [{ claim: "c" }]
    }).success
  );
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w @magpie/jobs`. Expected: FAIL (unknown key stripped / field missing).

- [ ] **Step 3: Implement**

In `packages/core/src/index.ts`: add the two interfaces (near `DraftContext`), extend the two job output interfaces and `Proposal` as above. `sources` may legitimately reference `internet`/`agent` descriptors — reference-only sources ground a claim as supporting context.

In `packages/jobs/src/schemas.ts`, next to `sourceMapUpdateSchema`:

```ts
// Mirrors @magpie/core ProvenanceClaim — per-claim source grounding on draft
// outputs. Must be on the schema or the broker strips it from the completed
// output before the API can persist it (same trap as mapUpdates).
const provenanceClaimSchema = z.object({
  claim: z.string().min(1),
  anchor: z.string().optional(),
  sources: z
    .array(
      z.object({
        sourceId: z.string(),
        path: z.string().optional(),
        lines: z.string().optional(),
        url: z.string().optional()
      })
    )
    .min(1)
}) satisfies z.ZodType<ProvenanceClaim>;
const provenanceField = z.array(provenanceClaimSchema).optional();
```

Add `provenance: provenanceField,` to `draftMarkdownProposalOutputSchema` and `draftSeedDocumentOutputSchema`.

- [ ] **Step 4: Run the tests** — `npm test -w @magpie/jobs` PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/jobs/src/schemas.ts packages/jobs/src/schemas.test.ts
git commit -m "feat(jobs): ProvenanceClaim contract on draft outputs (#214)"
git push -u origin claude/claim-provenance-capture
```

---

### Task 2: Migration 0049 + proposal store persistence

**Files:**
- Create: `packages/db/migrations/0049_proposal_provenance.sql`
- Modify: `apps/api/src/stores/proposal-store.ts` (`ProposalInput` already `extends DraftMarkdownProposalJobOutput` — it inherits `provenance` from Task 1 with **no edit needed**; `InMemoryProposalStore.create` ~line 66 must copy it)
- Modify: `apps/api/src/stores/postgres-proposal-store.ts` (`create` INSERT ~line 10, `ProposalRow` ~line 196, `mapRow` ~line 220)
- Test: `apps/api/src/stores/proposal-store.test.ts` (in-memory), `apps/api/src/stores/postgres-proposal-store.test.ts` (gated integration)

**Interfaces:**
- Produces: `Proposal.provenance` round-trips through both stores. `SELECT *` is used everywhere, so reads need only the `mapRow` line.

- [ ] **Step 1: Write the migration**

`packages/db/migrations/0049_proposal_provenance.sql`:

```sql
-- Per-claim source provenance captured from the draft job output (#214):
-- ProvenanceClaim[] — each substantive claim in the drafted markdown with the
-- source repo/path locations that ground it. Written once at proposal
-- creation, like draft_context (0020). On a MERGED proposal this row is the
-- append-only provenance EVENT for its target_path — documents themselves
-- carry no provenance (nothing to leak into answers). NULL: drafted before
-- this feature, or the draft omitted the field.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS provenance jsonb;
```

Run the migrator's ordering guard test (see `scripts/` — the same check the 0046 plan ran): expected PASS, prefix unique.

- [ ] **Step 2: Failing store tests**

In-memory (`proposal-store.test.ts`): create a proposal with a one-claim `provenance` array; assert `get(id)` returns it deep-equal, and that a create without the field leaves it `undefined`.

Postgres (`postgres-proposal-store.test.ts`, same `DATABASE_URL`-gated `describe` as its siblings at line 26): extend the existing `"round-trips a draft through create and get"` test (line 29) — add `provenance` to the created input and a `deepEqual` on the read-back.

- [ ] **Step 3: Verify failure** — in-memory test fails (field dropped by `create`).

- [ ] **Step 4: Implement**

- `InMemoryProposalStore.create`: add `provenance: input.provenance,` next to `draftContext: input.draftContext` (line ~87).
- `postgres-proposal-store.ts`:
  - INSERT column list gains `provenance`, VALUES gains `$15`, params gain `input.provenance ? JSON.stringify(input.provenance) : null` (mirror the `draft_context` binding at line 36).
  - `ProposalRow` gains `provenance: ProvenanceClaim[] | null;`
  - `mapRow` gains `provenance: row.provenance ?? undefined,` (mirror line 238).

- [ ] **Step 5: Validate and commit**

```bash
npm test -w @magpie/api && npm run typecheck && npm run test:db
git add packages/db/migrations/0049_proposal_provenance.sql apps/api/src/stores/
git commit -m "feat(store): persist proposal provenance (migration 0049) (#214)"
git push
```

---

### Task 3: Prompt changes — structured provenance instead of inline citations

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (`DRAFT_MARKDOWN_PROPOSAL` lines 137–173, `DRAFT_SEED_DOCUMENT` lines 175–213)
- Test: `packages/prompts/src/catalog.test.ts`

**Interfaces:**
- Consumes: nothing (pure prompt text). The watcher renders these via `JOB_INSTRUCTIONS` (`apps/watcher/src/job-prompts.ts:78-91`) — no watcher change needed.
- Produces: drafts that return `provenance` and contain no repo paths in the body. Task 4 consumes the field.

- [ ] **Step 1: Failing catalog tests**

Add to `catalog.test.ts` (match its loop style at lines 96–103):

```ts
test("draft prompts require structured provenance and forbid inline path citations", () => {
  for (const id of ["draft-markdown-proposal", "draft-seed-document"]) {
    const prompt = getPrompt(id);
    assert.ok(prompt?.instructions.includes('"provenance"'), `${id} instructs the provenance array`);
    assert.ok(
      !/cite their repository paths (in the text|\(e\.g\.)/.test(prompt?.instructions ?? ""),
      `${id} no longer instructs inline body citations`
    );
    assert.ok(prompt?.outputShape.includes("provenance"), `${id} outputShape mentions provenance`);
  }
});
```

Also bump any assertion the edits break (the count guard at lines 5–7 is unaffected — no new prompt).

- [ ] **Step 2: Verify failure**, then **Step 3: Implement**

In **both** prompts' Grounding blocks, replace the inline-citation bullet (line 148 resp. 191) with:

```
- Ground every factual claim in files you actually read. The document BODY must contain NO repository paths, file references, or source names — readers of answers built from this document must never see internal source locations. Instead, report every substantive claim in the "provenance" array of your JSON output: a short restatement of the claim, the slug of the section heading it lives under ("anchor"), and the source id + repo-relative path(s) (plus optional "L10-L20" line hints) of the files that ground it.
```

In `DRAFT_MARKDOWN_PROPOSAL`'s Rules, replace line 160 (`- Cite source file paths, URLs, or agent/internet source names in the rationale.`) with:

```
- The rationale stays a prose summary; per-claim citations belong in "provenance", not the rationale and never the body.
```

In `DRAFT_SEED_DOCUMENT`'s Rules, adjust the rationale bullet (line 200) the same way. Extend both Return-JSON blocks (lines 162–172 and 202–212) with:

```
  "provenance": [{"claim": "...", "anchor": "section-slug", "sources": [{"sourceId": "...", "path": "...", "lines": "L10-L20"}]}]
```

and mention `provenance` in each prompt's `outputShape` string.

- [ ] **Step 4: Run** — `npm test -w @magpie/prompts` PASS.

- [ ] **Step 5: Commit** — `feat(prompts): draft prompts emit structured provenance, no inline citations (#214)`; push.

---

### Task 4: Completion handlers persist provenance (+ warn when absent)

**Files:**
- Modify: `apps/api/src/features/proposals/service.ts` (`createProposalFromCompletedJob` lines 1336–1383, `createSeedProposalFromCompletedJob` lines 1459–1493; new helper next to `foldUncoveredPointsIntoRationale` ~line 1307)
- Test: `apps/api/src/features/proposals/service.test.ts`

**Interfaces:**
- Consumes: Task 1's output types (already flowing — `createProposalFromCompletedJob` spreads `withReport`, and `ProposalInput` inherits `provenance`, so the gap-draft path persists it with zero code once the spread includes it — VERIFY this rather than assuming; the seed handler builds its input explicitly and DOES need an edit).
- Produces: proposals with `provenance` for Tasks 5–6.

- [ ] **Step 1: Failing tests** (follow the flat `test(...)` style; model on the uncoveredPoints tests at lines 2030/2056)

1. `createProposalFromCompletedJob persists the draft's provenance on the proposal` — complete a `draft_markdown_proposal` job whose output has a provenance array; assert the created proposal carries it deep-equal.
2. `createSeedProposalFromCompletedJob persists provenance` — same for seed.
3. `a draft without provenance still creates the proposal` — assert `proposal.provenance === undefined` and creation succeeds (the warn is fire-and-forget; do not assert on logger internals unless the file already has a logger-capture idiom — check before inventing one).

- [ ] **Step 2: Verify failure** (seed test fails; gap-draft test may already pass via the spread — if so, keep it as a regression guard).

- [ ] **Step 3: Implement**

New helper (next to `foldUncoveredPointsIntoRationale`, same operator-visibility rationale):

```ts
// #214: drafts must report per-claim provenance. Absence is tolerated (the
// field is optional end-to-end; review + the verify patrol enforce quality)
// but warned, so silent regressions in drafter behaviour are operator-visible.
function warnMissingProvenance(job: JobView, output: { targetPath: string; provenance?: ProvenanceClaim[] }): void {
  if (!output.provenance || output.provenance.length === 0) {
    logger.warn(
      { jobId: job.id, jobType: job.type, targetPath: output.targetPath },
      "draft completed without per-claim provenance; proposal will carry none"
    );
  }
}
```

Call it in both handlers. In `createSeedProposalFromCompletedJob`, add `provenance: parsed.data.provenance,` to the `create` input (line ~1475–1492). In `createProposalFromCompletedJob`, confirm the `withReport` spread carries it into `create`; if the create-input literal enumerates fields instead, add it explicitly.

- [ ] **Step 4: Run** — `npm test -w @magpie/api` PASS.

- [ ] **Step 5: Commit** — `feat(api): persist draft provenance on proposals, warn when absent (#214)`; push.

---

### Task 5: PR body renders the provenance map

**Files:**
- Modify: `apps/watcher/src/runners/publication.ts` (`proposalSchema` lines 119–129, `buildPullRequestBody` lines 348–362)
- Test: `apps/watcher/src/runners/publication.test.ts`

**Interfaces:**
- Consumes: the full proposal from the API's execution-context endpoint (`getProposalExecutionContext`, service.ts 1054–1074, returns the stored `Proposal` as-is — `provenance` arrives with **no API edit** once Task 2 lands; the watcher just has to stop dropping it at parse time).
- Produces: the human-facing provenance surface. For local-git flows (no PR) the console view (Task 6) is the equivalent surface — no watcher work needed there (the `destination === "local-git"` branch at lines 227–257 never builds a body).

- [ ] **Step 1: Failing test**

`buildPullRequestBody` is un-exported and currently has NO body-content test — assert through the `raisePullRequest` mock instead (the runner tests already mock it; see lines 74/93 in `publication.test.ts`). New test in the existing `describe("PublicationRunner")`:

```ts
test("renders the proposal's claim provenance into the PR body", ...)
```

Fixture proposal carries two claims (one with `anchor` + `lines`, one without); capture the `body` argument passed to the `raisePullRequest` mock and assert it contains `### Claim provenance`, both claim texts, and `docs/ops/logging.md (L10-L14)`. Add a sibling assertion to an existing no-provenance test: body does NOT contain `### Claim provenance`.

- [ ] **Step 2: Verify failure**, then **Step 3: Implement**

- `proposalSchema` gains `provenance: z.array(provenanceClaimSchema).optional()` — import/duplicate the claim schema shape locally the way `changesetChangeSchema` is (this file keeps local zod mirrors; match that idiom rather than exporting from `@magpie/jobs` — check whether `@magpie/jobs` exports are already imported here and prefer the import if the pattern allows).
- `buildPullRequestBody` appends, when `proposal.provenance?.length`:

```
### Claim provenance

- **<anchor ?? "(document)">** — <claim>
  - <sourceId>: <path><lines ? ` (${lines})` : ""><url ? ` ${url}` : "">
```

- Fix the stale comment at line 348: it says "mirroring the API's buildPullRequestBody" but the API copy no longer exists — reword to "Human-facing PR description (single render site)".

- [ ] **Step 4: Run** — `npm test -w @magpie/watcher` PASS.

- [ ] **Step 5: Commit** — `feat(watcher): render claim provenance in the proposal PR body (#214)`; push.

---

### Task 6: Web console — provenance in the proposal view

**Files:**
- Modify: `apps/web/src/components/ProposalsPanel.tsx` (new section in `ProposalPreview`, after the `DraftContext` `<details>` block ending line ~281, before `<Actions>` at 282)
- Test: `apps/web/src/components/ProposalsPanel.test.tsx`

**Interfaces:**
- Consumes: `Proposal.provenance` — already on the payload (the API does no DTO mapping and the web re-exports the core type via `apps/web/src/lib/types.ts:18`). No provider/fetch changes.

- [ ] **Step 1: Failing test** — extend `ProposalsPanel.test.tsx` (node:test + `renderMarkup` HTML-string assertions, fixture builder `branchPushed()` at lines 9–26): a proposal with a provenance claim renders the claim text and source path; a proposal without renders no "Claim provenance" heading.

- [ ] **Step 2: Verify failure**, then **Step 3: Implement**

A `<details>` section mirroring the `DraftContext` idiom (styled component at lines 54–60): summary "Claim provenance (N)", body a `ClusterGaps`-style list (reuse `ClusterGaps`, lines 69–87, if its shape fits; otherwise a sibling styled `ul` reading `p => p.theme.*`) — one `<li>` per claim: claim text, then a muted line of `sourceId: path (lines)` entries. **No .css files; Emotion + theme tokens + `ui` primitives only.**

- [ ] **Step 4: Run** — `npm test -w @magpie/web` PASS; `npm run lint`.

- [ ] **Step 5: Commit** — `feat(web): show claim provenance on the proposal view (#214)`; push.

---

### Task 7: Cleanup of existing inline citations — via the verify→correct patrol

The spec's cleanup section originally sketched a one-off script; this plan replaces it with the existing patrol (queue-only, PR-reviewed, catches stragglers continuously) — **amend the spec's "Answer path and cleanup" section accordingly in this task's commit.**

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (`VERIFY_DOCUMENT` rules lines 363–368, `CORRECT_DOCUMENT` rules lines 399–407)
- Modify: `docs/superpowers/specs/2026-07-08-claim-provenance-design.md` (cleanup section)
- Test: `packages/prompts/src/catalog.test.ts`

- [ ] **Step 1: Failing test** — `verify-document` instructions mention inline repository-path citations as flaggable; `correct-document` instructions mention removing them.

- [ ] **Step 2: Implement**

`VERIFY_DOCUMENT` rules gain:

```
- Inline repository-path citations in the document body (e.g. "(see Docs/.../ingestion.md)") are a defect regardless of factual accuracy — internal source paths must never appear in published content. Flag each as a claim with reason "inline source-path citation".
```

`CORRECT_DOCUMENT` rules gain:

```
- A claim flagged as an inline source-path citation is a formatting defect, not a factual error: remove the parenthetical/reference from the body and smooth the sentence; do not change the factual content it was attached to.
```

The existing fix-patrol pipeline (verify finding → `correct_document` enqueue at `apps/api/src/features/patrol/service.ts:314–327` → corrective proposal → review) needs **no code change**.

- [ ] **Step 3: Run** — `npm test -w @magpie/prompts` PASS.

- [ ] **Step 4: Full validation sweep**

```bash
npm run build && npm run typecheck && npm run lint && npm test && npm run test:db
```

- [ ] **Step 5: Commit** — `feat(prompts): patrol flags and strips legacy inline citations (#214)` (includes the spec amendment); push.

---

### Task 8: Documentation

- [ ] Update `docs/ai-jobs.md` (draft job outputs now include `provenance`) and `docs/architecture.md` where proposal review surfaces are described; note the event-log model briefly and link the spec. Commit `docs: claim provenance phase 1 (#214)`; push.

## Done when

- A completed draft job's provenance survives broker → proposal row → API payload → PR body → console, verified by the tests above.
- The two draft prompts contain no inline-citation instruction; catalog tests lock that in.
- All validation commands green, including `test:db` (migration 0049 applied on a clean container).
