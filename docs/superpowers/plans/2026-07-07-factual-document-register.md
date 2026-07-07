# Factual Document Register (#213) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Documents the system produces must be factual and descriptive — they state what
the sources state. This plan (the "register half" of issue #213) adds a shared register
contract to every content-producing prompt, replaces the "note the gap plainly"
instruction with an `uncoveredPoints` output field so uncovered material is omitted from
the document body and reported on the proposal rationale instead, and adds a pure
advisory-heading detector that FLAGS (never fails) drafts containing advisory sections
(Recommendations / Next steps / Roadmap / …) with a structured log warning plus a
reviewer-visible note on the proposal rationale.

**Architecture:** All prompt text lives in `packages/prompts/src/catalog.ts` (the watcher
renders it; the API never calls a chat model inline). Draft/rewrite outputs come back
through the API's completion dispatcher (`apps/api/src/features/jobs/service.ts` →
`completeJob`), which fans out to the proposal-creating handlers in
`apps/api/src/features/proposals/service.ts`, the fold appliers in
`apps/api/src/scheduling/fold.ts`, and the source-sync plan attach in
`apps/api/src/features/source-sync/service.ts` — those consumption points are where the
detector and the uncovered-points reporting are wired. The detector itself is a pure
function in `packages/markdown` (already a dependency of `@magpie/api`; the web app does
not import it, so extending its barrel is safe).

**Tech Stack:** TypeScript ESM/NodeNext, zod, node:test (colocated unit tests, run via
`npm test -w <pkg>`), pino structured logging.

## Global Constraints

- **OUT OF SCOPE (issue #214):** do NOT remove or change the inline source-path citation
  instructions in any prompt (e.g. `cite their repository paths (e.g. "(see
  Docs/...)")`). Inline citations are currently the system's only provenance and must
  stay until #214 lands.
- **Queue-only AI:** these changes are prompt text, pure functions, and output
  consumption only. No new AI calls, no new job types.
- **ESM/NodeNext:** every relative import uses a `.js` extension, in tests too.
- **No `unknown`/`any` casts** to silence types.
- **knip runs STRICT in CI** (`npm run deadcode`): every new export must be consumed by
  another file. This plan keeps `FACTUAL_REGISTER_CONTRACT` and the API-side helpers
  module-private where nothing else needs them, and only exports what a second file
  imports.
- **Advisory detection is a flag, never a hard failure:** false positives are possible
  (a document legitimately describing a roadmap the source itself states). Nothing in
  this plan rejects, fails, or blocks a draft.
- **Workspace test resolution:** `@magpie/*` resolves to `dist` in cross-package tests —
  run `npm run build` before testing a package that consumes another package's change.
- Validate as you go; commit after every task.

---

### Task 1: `FACTUAL_REGISTER_CONTRACT` in every content-producing prompt

The seven prompts that author or rewrite KB document markdown gain a shared register
constant (mirroring the existing `CONSERVATIVE_CONTRACT` pattern — module-private, tested
by substring assertions through `getPrompt`): `draft-markdown-proposal`,
`draft-seed-document`, `fold-markdown-proposal`, `fold-changeset-proposal`,
`source-change-sync`, `correct-document`, `improve-document`. (`dedupe-documents` and
`split-document` are deliberately excluded: they reorganise existing KB content and
already forbid introducing new facts; they are also outside the fixed scope list.)

**Files**
- `packages/prompts/src/catalog.ts` (edit)
- `packages/prompts/src/catalog.test.ts` (edit)

**Interfaces**
- New module-private constant `FACTUAL_REGISTER_CONTRACT: string` in `catalog.ts`
  (NOT exported — knip would flag an export only used in-file; tests assert through
  `getPrompt(id).instructions`).
- No signature changes; only `PromptDefinition.instructions` strings change.

**Steps**

- [ ] Write the failing test. Append to `packages/prompts/src/catalog.test.ts`:

  ```ts
  // The factual-register contract (#213): every prompt that authors or rewrites KB
  // document markdown must carry the shared register clause forbidding self-authored
  // advisory content (recommendations, next steps, roadmaps, editorial commentary)
  // while still allowing a document to DESCRIBE a plan a source itself states.
  const CONTENT_PRODUCING_PROMPT_IDS = [
    "draft-markdown-proposal",
    "draft-seed-document",
    "fold-markdown-proposal",
    "fold-changeset-proposal",
    "source-change-sync",
    "correct-document",
    "improve-document"
  ];

  test("every content-producing prompt carries the factual-register contract", () => {
    for (const id of CONTENT_PRODUCING_PROMPT_IDS) {
      const instructions = getPrompt(id)?.instructions ?? "";
      assert.match(instructions, /factual and descriptive/, `${id} misses the register clause`);
      assert.match(instructions, /NEVER author your own recommendations/, `${id} misses the advisory ban`);
      assert.match(instructions, /IS allowed/, `${id} misses the source-stated-plan exception`);
    }
  });
  ```

- [ ] Run it and confirm the failure:
  `npm test -w @magpie/prompts`
  — expect `every content-producing prompt carries the factual-register contract` to
  fail with `draft-markdown-proposal misses the register clause`.

- [ ] Implement. In `packages/prompts/src/catalog.ts`, directly below the existing
  `CONSERVATIVE_CONTRACT` constant, add:

  ```ts
  // Shared register contract for every prompt that authors or rewrites knowledge-base
  // document markdown (gap drafts, seed drafts, both folds, source-sync rewrites,
  // corrective rewrites, improve growth). Issue #213: drafts were producing
  // "Recommendations" / "Next steps" / phased-plan sections and editorial commentary
  // on the sources. Documents DESCRIBE their sources; the one carve-out is that
  // describing a plan or roadmap a source itself states is a factual claim about
  // that source, so it stays allowed.
  const FACTUAL_REGISTER_CONTRACT =
    "Register: the document is factual and descriptive — it states what the sources state, in the " +
    "present tense. NEVER author your own recommendations, next steps, action items, roadmaps, phased " +
    "plans, or editorial commentary on the sources (for example that something \"should\" be published " +
    "or implemented). Describing a plan, roadmap, or recommendation that a source itself states is a " +
    "factual claim about that source and IS allowed — attribute it to the source. Do not add sections " +
    "such as \"Recommendations\", \"Next steps\", \"Action items\", \"Roadmap\", or \"Future work\" " +
    "unless they describe content a source itself states.";
  ```

- [ ] Embed it as the FIRST bullet of the `Rules:` block in each of the seven prompts
  (all are template literals, so interpolate). The exact insertions:

  - `DRAFT_MARKDOWN_PROPOSAL` — after the line `Rules:\n- Return JSON only.` insert:
    ```text
    - ${FACTUAL_REGISTER_CONTRACT}
    ```
  - `DRAFT_SEED_DOCUMENT` — after `Rules:\n- Your FINAL message must be JSON only, matching the shape below. No prose around it.` insert:
    ```text
    - ${FACTUAL_REGISTER_CONTRACT}
    ```
  - `FOLD_MARKDOWN_PROPOSAL` — after `Rules:\n- Return JSON only.` insert:
    ```text
    - ${FACTUAL_REGISTER_CONTRACT} When either input contains advisory sections you cannot attribute to a source, do not carry them forward as your own voice.
    ```
  - `FOLD_CHANGESET_PROPOSAL` — after `Rules:\n- Return JSON only.` insert:
    ```text
    - ${FACTUAL_REGISTER_CONTRACT}
    ```
  - `SOURCE_CHANGE_SYNC` — after `Rules:\n- Return JSON only.` insert:
    ```text
    - ${FACTUAL_REGISTER_CONTRACT}
    ```
  - `CORRECT_DOCUMENT` — after `Rules:\n- Return JSON only.` insert:
    ```text
    - ${FACTUAL_REGISTER_CONTRACT}
    ```
  - `IMPROVE_DOCUMENT` — after `Rules:\n- Return JSON only.` insert:
    ```text
    - ${FACTUAL_REGISTER_CONTRACT}
    ```

  (These five prompts are plain template literals; `DRAFT_MARKDOWN_PROPOSAL` and
  `DRAFT_SEED_DOCUMENT` are too — in every case the inserted line is
  `- ${FACTUAL_REGISTER_CONTRACT}` inside the backtick template.)

- [ ] Run again and confirm green: `npm test -w @magpie/prompts` — all tests pass,
  including the pre-existing "instructions never end with a trailing newline" and
  "catalog has exactly 19 prompts" tests (no prompt added or removed).

- [ ] Validate: `npm run build && npm run typecheck && npm run lint`

- [ ] Commit:
  `git commit -am "feat(prompts): factual-register contract in every content-producing prompt (#213)"`

---

### Task 2: `uncoveredPoints` output contract; gaps omitted from document bodies

Remove `DRAFT_SEED_DOCUMENT`'s "note the gap plainly" instruction and
`DRAFT_MARKDOWN_PROPOSAL`'s equivalent "say so plainly", replacing both with: OMIT the
uncovered point from the document body and report it in a new optional
`uncoveredPoints: string[]` output field. This task changes the contract (core type,
zod schema, prompt text); Task 3 consumes it API-side.

**Rationale for the reporting mechanism (scope item 2 judgement call):** the drafter's
report lands on the proposal **rationale** (Task 3), not in a new store column or as
synthetic gap rows. The gap pipeline is demand-driven (question logs → clusters);
fabricating question-log entries from a drafter's self-report would pollute demand data
and is a product decision beyond this issue. The rationale is already the
reviewer-visible "why" surface on every proposal (web console + PR body), persists with
no migration, and knip/schema impact is minimal. The structured `uncoveredPoints` field
(rather than free text) keeps the door open for a later pipeline integration.

**Files**
- `packages/core/src/index.ts` (edit — two interfaces)
- `packages/jobs/src/schemas.ts` (edit — two output schemas)
- `packages/jobs/src/schemas.test.ts` (edit)
- `packages/prompts/src/catalog.ts` (edit — two prompts)
- `packages/prompts/src/catalog.test.ts` (edit)

**Interfaces**
- `DraftMarkdownProposalJobOutput` gains `uncoveredPoints?: string[]`
- `DraftSeedDocumentJobOutput` gains `uncoveredPoints?: string[]`
- `draftMarkdownProposalOutputSchema` / `draftSeedDocumentOutputSchema` gain
  `uncoveredPoints: z.array(z.string()).optional()`
- Prompt `outputShape` strings for both prompts become
  `"{ title, targetPath, markdown, rationale, uncoveredPoints? }"`

**Steps**

- [ ] Write the failing schema test. Append to `packages/jobs/src/schemas.test.ts`
  (add `draftMarkdownProposalOutputSchema` and `draftSeedDocumentOutputSchema` to the
  existing import from `./schemas.js`):

  ```ts
  test("draft outputs accept and preserve optional uncoveredPoints", () => {
    const base = { title: "T", targetPath: "t.md", markdown: "# T", rationale: "r" };
    // Absent stays valid (back-compat with providers that report nothing).
    assert.equal(draftMarkdownProposalOutputSchema.safeParse(base).success, true);
    assert.equal(draftSeedDocumentOutputSchema.safeParse(base).success, true);
    // Present round-trips.
    const gap = draftSeedDocumentOutputSchema.parse({ ...base, uncoveredPoints: ["refund SLAs"] });
    assert.deepEqual(gap.uncoveredPoints, ["refund SLAs"]);
    const draft = draftMarkdownProposalOutputSchema.parse({ ...base, uncoveredPoints: ["retry limits"] });
    assert.deepEqual(draft.uncoveredPoints, ["retry limits"]);
    // Malformed entries are rejected, not coerced.
    assert.equal(draftSeedDocumentOutputSchema.safeParse({ ...base, uncoveredPoints: [42] }).success, false);
  });
  ```

- [ ] Write the failing prompt test. Append to `packages/prompts/src/catalog.test.ts`:

  ```ts
  // #213: uncovered points are OMITTED from the document body and reported in the
  // structured uncoveredPoints field — never written into the markdown as notes.
  test("draft prompts route uncovered points to uncoveredPoints, not the document body", () => {
    for (const id of ["draft-markdown-proposal", "draft-seed-document"]) {
      const instructions = getPrompt(id)?.instructions ?? "";
      assert.doesNotMatch(instructions, /note the gap plainly/, `${id} still writes gaps into the body`);
      assert.doesNotMatch(instructions, /say so plainly/, `${id} still writes gaps into the body`);
      assert.match(instructions, /OMIT it from the document entirely/, `${id} misses the omission rule`);
      assert.match(instructions, /"uncoveredPoints"/, `${id} misses the reporting field`);
    }
  });
  ```

- [ ] Run both and confirm the failures:
  `npm test -w @magpie/jobs` — expect a TS/tsx failure or assert failure (the schemas
  don't export the property yet: the `uncoveredPoints` key is stripped, so
  `deepEqual(gap.uncoveredPoints, [...])` fails against `undefined`).
  `npm test -w @magpie/prompts` — expect `draft-markdown-proposal still writes gaps into
  the body` (the `say so plainly` match).

- [ ] Implement the core types. In `packages/core/src/index.ts`:

  ```ts
  export interface DraftMarkdownProposalJobOutput {
    title: string;
    targetPath: string;
    markdown: string;
    rationale: string;
    // Points the gaps asked for that the sources do not support. #213: these are
    // OMITTED from the document body (a document states only what the sources
    // state) and reported here so the API can surface them on the proposal
    // rationale. Optional: absent when the sources covered everything.
    uncoveredPoints?: string[];
  }
  ```

  ```ts
  // Output of draft_seed_document: the authored document plus a short rationale.
  export interface DraftSeedDocumentJobOutput {
    title: string;
    targetPath: string;
    markdown: string;
    rationale: string;
    // Coverage points the sources do not support, OMITTED from the document body
    // (#213) and reported here for the proposal rationale.
    uncoveredPoints?: string[];
  }
  ```

- [ ] Implement the schemas. In `packages/jobs/src/schemas.ts`:

  ```ts
  export const draftMarkdownProposalOutputSchema = z.object({
    title: z.string(),
    targetPath: z.string(),
    markdown: z.string(),
    rationale: z.string(),
    // #213: source-uncovered points, omitted from the markdown by contract. Must be
    // declared here or the broker strips it before the completion handler reads it.
    uncoveredPoints: z.array(z.string()).optional()
  }) satisfies z.ZodType<DraftMarkdownProposalJobOutput>;
  ```

  ```ts
  export const draftSeedDocumentOutputSchema = z.object({
    title: z.string(),
    targetPath: z.string(),
    markdown: z.string(),
    rationale: z.string(),
    // #213: see draftMarkdownProposalOutputSchema.uncoveredPoints.
    uncoveredPoints: z.array(z.string()).optional()
  }) satisfies z.ZodType<DraftSeedDocumentJobOutput>;
  ```

- [ ] Implement the prompt changes in `packages/prompts/src/catalog.ts`:

  - `DRAFT_MARKDOWN_PROPOSAL`: replace the grounding bullet
    ```text
    - Never introduce assertions the sources do not support. Do not fabricate figures, dates, or APIs. Where the sources genuinely do not cover a point, write only what can be supported and say so plainly.
    ```
    with
    ```text
    - Never introduce assertions the sources do not support. Do not fabricate figures, dates, or APIs. Where the sources genuinely do not cover a point, OMIT it from the document entirely — never write the gap, a placeholder, or a note about missing coverage into the document body — and list that point in "uncoveredPoints" instead.
    ```
    and replace the Return JSON block
    ```json
    {
      "title": "string",
      "targetPath": "string",
      "markdown": "string",
      "rationale": "string"
    }
    ```
    with
    ```json
    {
      "title": "string",
      "targetPath": "string",
      "markdown": "string",
      "rationale": "string",
      "uncoveredPoints": ["a point the sources do not support (omit when none)"]
    }
    ```
    and update its `outputShape` to `'{ title, targetPath, markdown, rationale, uncoveredPoints? }'`.

  - `DRAFT_SEED_DOCUMENT`: replace the grounding bullet
    ```text
    - Never introduce assertions the sources do not support. Do not fabricate figures, dates, or APIs. If, after genuinely searching, the sources do not cover a point, write only what can be supported and note the gap plainly.
    ```
    with
    ```text
    - Never introduce assertions the sources do not support. Do not fabricate figures, dates, or APIs. If, after genuinely searching, the sources do not cover a coverage point, OMIT it from the document entirely — never write the gap, a placeholder, or a note about missing coverage into the document body — and list that point in "uncoveredPoints" instead.
    ```
    and replace the Return JSON block
    ```json
    {
      "title": "the document title",
      "targetPath": "kebab-case/path.md",
      "markdown": "the full document",
      "rationale": "string"
    }
    ```
    with
    ```json
    {
      "title": "the document title",
      "targetPath": "kebab-case/path.md",
      "markdown": "the full document",
      "rationale": "string",
      "uncoveredPoints": ["a coverage point the sources do not support (omit when none)"]
    }
    ```
    and update its `outputShape` to `"{ title, targetPath, markdown, rationale, uncoveredPoints? }"`.

- [ ] Rebuild so `@magpie/jobs` tests resolve the fresh `@magpie/core` dist, then run:
  `npm run build && npm test -w @magpie/jobs && npm test -w @magpie/prompts` — all green.

- [ ] Validate: `npm run typecheck && npm run lint`

- [ ] Commit:
  `git commit -am "feat(jobs,prompts): uncoveredPoints on draft outputs; gaps omitted from document bodies (#213)"`

---

### Task 3: API consumption — fold `uncoveredPoints` into the proposal rationale

The two completion handlers that consume draft outputs
(`createProposalFromCompletedJob` for `draft_markdown_proposal`, including its
regeneration branch, and `createSeedProposalFromCompletedJob` for
`draft_seed_document`) log a structured warning and append the reported points to the
stored rationale, so the reviewer sees what the sources could not support without it
polluting the document body.

**Files**
- `apps/api/src/features/proposals/service.ts` (edit)
- `apps/api/src/features/proposals/service.test.ts` (edit)

**Interfaces**
- New module-private function in `service.ts` (private — nothing outside the module
  needs it, and knip STRICT flags exports only used in-file):
  `foldUncoveredPointsIntoRationale(job: JobView, output: { targetPath: string; rationale: string; uncoveredPoints?: string[] }): string`
- No public signature changes; `createProposalFromCompletedJob` and
  `createSeedProposalFromCompletedJob` keep their existing signatures.

**Steps**

- [ ] Write the failing tests. Append to
  `apps/api/src/features/proposals/service.test.ts` (uses the existing
  `makeTestContext` / `proposals` imports already at the top of the file):

  ```ts
  test("createProposalFromCompletedJob folds reported uncoveredPoints into the rationale, not the body", async () => {
    const ctx = makeTestContext();
    const job = await ctx.jobs.create("draft_markdown_proposal", {
      provider: "codex",
      gapSummaries: ["How to configure X"],
      triggeringQuestions: ["How do I configure X?"],
      evidence: [],
      sources: [],
      expectedOutput: "markdown_proposal"
    });
    const output = {
      title: "Configuring X",
      targetPath: "configuring-x.md",
      markdown: "# Configuring X",
      rationale: "grounded in repo docs",
      uncoveredPoints: ["X's retry limits", "X's default timeout"]
    };

    const proposal = await proposals.createProposalFromCompletedJob(ctx, job, output);
    assert.ok(proposal);
    assert.ok(proposal?.rationale?.includes("grounded in repo docs"), "original rationale is preserved");
    assert.ok(proposal?.rationale?.includes("Not covered by the sources"));
    assert.ok(proposal?.rationale?.includes("X's retry limits"));
    assert.equal(proposal?.markdown, "# Configuring X", "the note never lands in the document body");
  });

  test("createSeedProposalFromCompletedJob folds reported uncoveredPoints into the rationale", async () => {
    const ctx = makeTestContext();
    const job = await ctx.jobs.create("draft_seed_document", {
      flowId: "billing",
      coverage: ["what billing is", "refund SLAs"],
      sources: [],
      provider: "codex"
    });
    const output = {
      title: "Billing overview",
      targetPath: "billing.md",
      markdown: "# Billing",
      rationale: "seed",
      uncoveredPoints: ["refund SLAs"]
    };

    const proposal = await proposals.createSeedProposalFromCompletedJob(ctx, job, output);
    assert.ok(proposal?.rationale?.includes("Not covered by the sources"));
    assert.ok(proposal?.rationale?.includes("refund SLAs"));
    assert.equal(proposal?.markdown, "# Billing");
  });

  test("an empty or absent uncoveredPoints leaves the rationale untouched", async () => {
    const ctx = makeTestContext();
    const job = await ctx.jobs.create("draft_seed_document", {
      flowId: "billing",
      coverage: ["what billing is"],
      sources: [],
      provider: "codex"
    });
    const output = { title: "Billing", targetPath: "billing.md", markdown: "# Billing", rationale: "seed", uncoveredPoints: [] };

    const proposal = await proposals.createSeedProposalFromCompletedJob(ctx, job, output);
    assert.equal(proposal?.rationale, "seed");
  });
  ```

- [ ] Run and confirm the failure:
  `npm run build && npm test -w @magpie/api`
  — the two "folds reported uncoveredPoints" tests fail on the
  `includes("Not covered by the sources")` assertions.

- [ ] Implement. In `apps/api/src/features/proposals/service.ts`, add the private
  helper (near `splitGapSummaries`):

  ```ts
  // #213: a draft's contract is to OMIT source-uncovered points from the document
  // body and report them in uncoveredPoints. This folds that report into the
  // reviewer-visible rationale — the natural surfacing a proposal already has (web
  // console + PR body) — and warns so the omission is operator-visible. Deliberately
  // NOT synthetic gap rows: the gap pipeline is demand-driven (question logs), and
  // fabricating demand from a drafter's self-report is a product decision out of
  // scope here. Empty/absent reports return the rationale unchanged.
  function foldUncoveredPointsIntoRationale(
    job: JobView,
    output: { targetPath: string; rationale: string; uncoveredPoints?: string[] }
  ): string {
    const points = (output.uncoveredPoints ?? []).map((point) => point.trim()).filter((point) => point.length > 0);
    if (points.length === 0) {
      return output.rationale;
    }
    logger.warn(
      { jobId: job.id, jobType: job.type, targetPath: output.targetPath, uncoveredPoints: points },
      "draft reported source-uncovered points; omitted from the document body and recorded on the proposal rationale"
    );
    return `${output.rationale}\n\nNot covered by the sources (omitted from the document): ${points.join("; ")}.`;
  }
  ```

- [ ] Wire it into `createProposalFromCompletedJob` — fold once, so the regeneration
  branch gets the same treatment:

  ```ts
    const input = job.input as Partial<DraftMarkdownProposalJobInput> & {
      triggeringQuestionIds?: string[];
    };

    const withReport: DraftMarkdownProposalJobOutput = {
      ...output,
      rationale: foldUncoveredPointsIntoRationale(job, output)
    };

    // A regeneration updates an already-published proposal in place and re-publishes,
    // rather than creating a new draft. Returns undefined so the caller's at-draft fold
    // hook is skipped — this proposal is already in flight, not a fresh draft.
    if (input.regenerateProposalId) {
      await applyRegeneratedProposal(ctx, input.regenerateProposalId, withReport);
      return undefined;
    }

    return ctx.stores.proposals.create({
      ...withReport,
      targetPath: resolveProposalTargetPath(destinationSubpath(ctx.repositoryDeps(), input.destinationId), output.title),
      ...
  ```
  (the rest of the `create({...})` object literal is unchanged; only `...output`
  becomes `...withReport`).

- [ ] Wire it into `createSeedProposalFromCompletedJob` — change the `rationale` field
  of its `ctx.stores.proposals.create({...})` call from

  ```ts
      rationale: parsed.data.rationale,
  ```
  to
  ```ts
      rationale: foldUncoveredPointsIntoRationale(job, parsed.data),
  ```

- [ ] Run again: `npm test -w @magpie/api` — the three new tests pass, and the
  pre-existing `createProposalFromCompletedJob` / `createSeedProposalFromCompletedJob` /
  regeneration tests stay green (outputs without `uncoveredPoints` are untouched).

- [ ] Validate: `npm run build && npm run typecheck && npm run lint`

- [ ] Commit:
  `git commit -am "feat(api): fold reported uncovered points into the proposal rationale (#213)"`

---

### Task 4: advisory-heading detector in `packages/markdown`

A pure, fence-aware scanner that returns the headings in a markdown document matching an
advisory blocklist. Lives in `@magpie/markdown` next to the existing heading-splitting
logic; consumed by the API in Task 5.

**Files**
- `packages/markdown/src/advisory.ts` (new)
- `packages/markdown/src/advisory.test.ts` (new)
- `packages/markdown/src/index.ts` (edit — barrel re-export; safe: `apps/web` does not
  import `@magpie/markdown`, only `@magpie/api` does)
- `packages/markdown/package.json` (edit — the `test`/`test:coverage` scripts currently
  run only `src/index.test.ts`; widen to the glob the other packages use)

**Interfaces**
- `export function findAdvisoryHeadings(markdown: string): string[]` — returns the
  original heading texts (deduplicated, first-seen order) whose normalised text
  contains a blocklist term as a whole word/phrase. Blocklist (module-private
  `ADVISORY_HEADING_TERMS: readonly string[]`): recommendation(s), next step(s),
  action item(s), action plan, roadmap, future work, future enhancements,
  improvement plan, implementation plan, suggested improvements, proposed improvements.

**Steps**

- [ ] Widen the test scripts in `packages/markdown/package.json` so the new test file
  runs (mirrors `packages/prompts/package.json`):

  ```json
  "test": "node --import tsx --test \"src/**/*.test.ts\"",
  "test:coverage": "node --import tsx --test --experimental-test-coverage --test-coverage-include=\"src/**\" --test-coverage-exclude=\"**/*.test.ts\" \"src/**/*.test.ts\"",
  ```

- [ ] Write the failing test at `packages/markdown/src/advisory.test.ts`:

  ```ts
  import assert from "node:assert/strict";
  import { describe, it } from "node:test";
  import { findAdvisoryHeadings } from "./index.js";

  describe("findAdvisoryHeadings", () => {
    it("flags the canonical advisory headings at any level", () => {
      const markdown = [
        "# Audit logging",
        "## How events are recorded",
        "## Recommendations",
        "### Next steps",
        "#### Phase 1 roadmap",
        "## Action items"
      ].join("\n");
      assert.deepEqual(findAdvisoryHeadings(markdown), [
        "Recommendations",
        "Next steps",
        "Phase 1 roadmap",
        "Action items"
      ]);
    });

    it("matches whole words only — descriptive headings pass", () => {
      const markdown = [
        "## Overview",
        "## How ingestion works",
        "## Stepwise processing", // "step" is a substring, not the phrase "next steps"
        "## Recommendation engine architecture" // contains the word — flagged (a reviewer decides)
      ].join("\n");
      assert.deepEqual(findAdvisoryHeadings(markdown), ["Recommendation engine architecture"]);
    });

    it("ignores headings inside fenced code blocks", () => {
      const markdown = ["## Usage", "```md", "## Recommendations", "```", "body"].join("\n");
      assert.deepEqual(findAdvisoryHeadings(markdown), []);
    });

    it("deduplicates repeated headings and preserves first-seen order", () => {
      const markdown = ["## Next steps", "text", "## Roadmap", "text", "## Next steps"].join("\n");
      assert.deepEqual(findAdvisoryHeadings(markdown), ["Next steps", "Roadmap"]);
    });

    it("returns empty for a document with no headings", () => {
      assert.deepEqual(findAdvisoryHeadings("just a paragraph"), []);
    });
  });
  ```

- [ ] Run and confirm the failure:
  `npm test -w @magpie/markdown`
  — expect a module-resolution/undefined-export failure (`findAdvisoryHeadings` does
  not exist yet).

- [ ] Implement `packages/markdown/src/advisory.ts`:

  ```ts
  // Advisory-register heading detection (#213). Documents this system produces must
  // be factual and descriptive; headings like "Recommendations" or "Next steps"
  // signal the draft is recommending or planning in its own voice. Matching is a
  // FLAG, never a failure: a document may legitimately describe a roadmap a source
  // itself states, so consumers warn and surface — they never reject.
  const ADVISORY_HEADING_TERMS: readonly string[] = [
    "recommendation",
    "recommendations",
    "next step",
    "next steps",
    "action item",
    "action items",
    "action plan",
    "roadmap",
    "future work",
    "future enhancements",
    "improvement plan",
    "implementation plan",
    "suggested improvements",
    "proposed improvements"
  ];

  // Scans a markdown document's headings (fence-aware, like splitIntoSections) and
  // returns the original text of every heading whose normalised words contain a
  // blocklist term as a whole word/phrase. Deduplicated, first-seen order.
  export function findAdvisoryHeadings(markdown: string): string[] {
    const headings: string[] = [];
    let inFence = false;
    for (const line of markdown.split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) {
        continue;
      }
      const heading = /^#{1,6}\s+(.+)$/.exec(line);
      if (!heading) {
        continue;
      }
      const text = heading[1].trim();
      if (isAdvisoryHeading(text) && !headings.includes(text)) {
        headings.push(text);
      }
    }
    return headings;
  }

  function isAdvisoryHeading(text: string): boolean {
    // Normalise to space-separated lowercase words so terms match as whole
    // words/phrases: "Stepwise processing" must not match "next step", while
    // "Phase 1 roadmap" must match "roadmap".
    const words = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
    return ADVISORY_HEADING_TERMS.some((term) => words.includes(` ${term} `));
  }
  ```

- [ ] Re-export from the barrel. In `packages/markdown/src/index.ts`, add at the top
  (below the existing imports):

  ```ts
  export { findAdvisoryHeadings } from "./advisory.js";
  ```

- [ ] Run again: `npm test -w @magpie/markdown` — all green (including the existing
  `index.test.ts`, which the widened glob still runs).

- [ ] Validate: `npm run build && npm run typecheck && npm run lint`
  (knip note: `findAdvisoryHeadings` has no consumer until Task 5 — `npm run deadcode`
  will flag it if run between Tasks 4 and 5; that is expected and resolves in Task 5.
  If tasks are executed by separate workers, run `npm run deadcode` only after Task 5.)

- [ ] Commit:
  `git commit -am "feat(markdown): advisory-heading detector (#213)"`

---

### Task 5: flag advisory drafts where the API consumes draft/rewrite outputs

A small register-check module in the API runs the detector over every
content-producing output the API consumes, emits a structured `logger.warn`, and
appends a reviewer-visible note to the proposal rationale (the proposal's natural
surfacing — web console + PR body). Wired at: gap drafts (incl. regeneration), seed
drafts, corrective rewrites, improve growth, source-sync proposals, and both fold
appliers (log-only there — a fold rewrites markdown, not rationale, and the original
draft's rationale note survives the fold). Dedupe/split are deliberately NOT wired:
they reorganise existing KB content, so any advisory heading pre-existed in the
knowledge base and flagging every shuffle is noise.

**Files**
- `apps/api/src/features/proposals/register-check.ts` (new)
- `apps/api/src/features/proposals/register-check.test.ts` (new)
- `apps/api/src/features/proposals/service.ts` (edit)
- `apps/api/src/features/proposals/service.test.ts` (edit)
- `apps/api/src/features/source-sync/service.ts` (edit)
- `apps/api/src/scheduling/fold.ts` (edit)

**Interfaces** (all exported from `register-check.ts`; each is imported by at least one
other file, satisfying knip STRICT: `collectAdvisoryHeadings` by `fold.ts` and
`register-check.ts` consumers, `advisoryNote` by `service.ts`'s regeneration branch,
`flagAdvisoryDraft` by `service.ts` and `source-sync/service.ts`):
- `collectAdvisoryHeadings(markdown: string, changeset?: ChangesetChange[]): string[]`
- `advisoryNote(headings: string[]): string`
- `flagAdvisoryDraft(input: ProposalInput, context: { jobId?: string; jobType: string }): ProposalInput`

**Steps**

- [ ] Write the failing unit tests at
  `apps/api/src/features/proposals/register-check.test.ts`:

  ```ts
  import assert from "node:assert/strict";
  import { describe, it } from "node:test";
  import { advisoryNote, collectAdvisoryHeadings, flagAdvisoryDraft } from "./register-check.js";
  import type { ProposalInput } from "../../stores/proposal-store.js";

  const baseInput: ProposalInput = {
    title: "T",
    targetPath: "kb/t.md",
    markdown: "# T\n\nbody",
    rationale: "grounded",
    evidence: []
  };

  describe("collectAdvisoryHeadings", () => {
    it("scans the primary markdown when there is no changeset", () => {
      assert.deepEqual(
        collectAdvisoryHeadings("# Doc\n\n## Recommendations\n\n## Usage"),
        ["Recommendations"]
      );
    });

    it("scans every changeset write and skips deletes, deduplicating across files", () => {
      const headings = collectAdvisoryHeadings("# unused primary", [
        { path: "kb/a.md", content: "# A\n\n## Next steps" },
        { path: "kb/b.md", content: "# B\n\n## Next steps\n\n## Roadmap" },
        { path: "kb/c.md", delete: true }
      ]);
      assert.deepEqual(headings, ["Next steps", "Roadmap"]);
    });
  });

  describe("flagAdvisoryDraft", () => {
    it("returns the input unchanged when no advisory heading is present", () => {
      const flagged = flagAdvisoryDraft(baseInput, { jobType: "draft_seed_document" });
      assert.equal(flagged, baseInput);
    });

    it("appends the reviewer note to the rationale and preserves every other field", () => {
      const advisory: ProposalInput = { ...baseInput, markdown: "# T\n\n## Recommendations\n\ndo things" };
      const flagged = flagAdvisoryDraft(advisory, { jobId: "job-1", jobType: "draft_seed_document" });
      assert.equal(flagged.markdown, advisory.markdown, "the document body is never edited");
      assert.ok(flagged.rationale.startsWith("grounded"), "the original rationale is preserved");
      assert.ok(flagged.rationale.includes(advisoryNote(["Recommendations"])));
      assert.equal(flagged.targetPath, advisory.targetPath);
    });
  });
  ```

- [ ] Run and confirm the failure:
  `npm test -w @magpie/api` — module `./register-check.js` does not exist yet.

- [ ] Implement `apps/api/src/features/proposals/register-check.ts`:

  ```ts
  import { findAdvisoryHeadings } from "@magpie/markdown";
  import type { ChangesetChange } from "@magpie/core";
  import { logger } from "../../logger.js";
  import type { ProposalInput } from "../../stores/proposal-store.js";

  // Advisory-register check (#213). A draft containing advisory-style headings
  // (Recommendations / Next steps / Roadmap / …) is FLAGGED — structured warning +
  // reviewer note on the rationale — never hard-failed: a document may legitimately
  // describe a roadmap a source itself states, so a human decides.

  // Collects advisory headings across a proposal's content: every changeset write
  // when a file-set is present, else the primary markdown. Deduplicated across files,
  // first-seen order.
  export function collectAdvisoryHeadings(markdown: string, changeset?: ChangesetChange[]): string[] {
    const bodies: string[] =
      changeset && changeset.length > 0
        ? changeset.flatMap((change) => (!change.delete && typeof change.content === "string" ? [change.content] : []))
        : [markdown];
    const headings: string[] = [];
    for (const body of bodies) {
      for (const heading of findAdvisoryHeadings(body)) {
        if (!headings.includes(heading)) {
          headings.push(heading);
        }
      }
    }
    return headings;
  }

  // The reviewer-visible note appended to a flagged proposal's rationale.
  export function advisoryNote(headings: string[]): string {
    const quoted = headings.map((heading) => `"${heading}"`).join(", ");
    return (
      `Register check: advisory-style headings detected (${quoted}). Documents must describe what the ` +
      `sources state — verify these sections describe a plan the sources themselves state, not authored ` +
      `recommendations.`
    );
  }

  // Runs the check over a draft ProposalInput just before it is stored: warns and
  // appends the note to the rationale. Returns the input untouched when clean.
  export function flagAdvisoryDraft(
    input: ProposalInput,
    context: { jobId?: string; jobType: string }
  ): ProposalInput {
    const headings = collectAdvisoryHeadings(input.markdown, input.changeset);
    if (headings.length === 0) {
      return input;
    }
    logger.warn(
      { ...context, targetPath: input.targetPath, advisoryHeadings: headings },
      "draft contains advisory-style headings; flagged on the proposal rationale (not blocked)"
    );
    return { ...input, rationale: `${input.rationale}\n\n${advisoryNote(headings)}` };
  }
  ```

- [ ] Run the unit tests again: `npm run build && npm test -w @magpie/api` — the
  register-check tests pass.

- [ ] Write the failing wiring tests. Append to
  `apps/api/src/features/proposals/service.test.ts`:

  ```ts
  test("createSeedProposalFromCompletedJob flags advisory-style headings on the rationale", async () => {
    const ctx = makeTestContext();
    const job = await ctx.jobs.create("draft_seed_document", {
      flowId: "billing",
      coverage: ["what billing is"],
      sources: [],
      provider: "codex"
    });
    const output = {
      title: "Billing overview",
      targetPath: "billing.md",
      markdown: "# Billing\n\n## Recommendations\n\nAdopt three phases.",
      rationale: "seed"
    };

    const proposal = await proposals.createSeedProposalFromCompletedJob(ctx, job, output);
    assert.ok(proposal?.rationale?.includes("Register check: advisory-style headings detected"));
    assert.ok(proposal?.rationale?.includes('"Recommendations"'));
    assert.ok(proposal?.markdown.includes("## Recommendations"), "flag only — the body is never edited");
  });

  test("createProposalFromCompletedJob flags advisory-style headings on the rationale", async () => {
    const ctx = makeTestContext();
    const job = await ctx.jobs.create("draft_markdown_proposal", {
      provider: "codex",
      gapSummaries: ["audit logging"],
      triggeringQuestions: ["How is audit logging done?"],
      evidence: [],
      sources: [],
      expectedOutput: "markdown_proposal"
    });
    const output = {
      title: "Audit logging",
      targetPath: "audit-logging.md",
      markdown: "# Audit logging\n\n## Next steps\n\nImplement phase 1.",
      rationale: "grounded"
    };

    const proposal = await proposals.createProposalFromCompletedJob(ctx, job, output);
    assert.ok(proposal?.rationale?.includes("Register check: advisory-style headings detected"));
    assert.ok(proposal?.rationale?.includes('"Next steps"'));
  });

  test("a clean draft's rationale carries no register-check note", async () => {
    const ctx = makeTestContext();
    const job = await ctx.jobs.create("draft_seed_document", {
      flowId: "billing",
      coverage: ["what billing is"],
      sources: [],
      provider: "codex"
    });
    const output = { title: "Billing", targetPath: "billing.md", markdown: "# Billing\n\n## Plans", rationale: "seed" };
    const proposal = await proposals.createSeedProposalFromCompletedJob(ctx, job, output);
    assert.equal(proposal?.rationale, "seed");
  });
  ```

- [ ] Run and confirm the two flag tests fail (`rationale` lacks the note), then wire
  the API. In `apps/api/src/features/proposals/service.ts`, add the import:

  ```ts
  import { advisoryNote, collectAdvisoryHeadings, flagAdvisoryDraft } from "./register-check.js";
  ```

  and wrap the `ctx.stores.proposals.create({...})` argument at four sites with
  `flagAdvisoryDraft(..., { jobId: job.id, jobType: job.type })`:

  - `createProposalFromCompletedJob` (gap drafts):
    ```ts
    return ctx.stores.proposals.create(
      flagAdvisoryDraft(
        {
          ...withReport,
          targetPath: resolveProposalTargetPath(destinationSubpath(ctx.repositoryDeps(), input.destinationId), output.title),
          evidence: input.evidence ?? [],
          gapSummary: input.gapSummaries ? joinGapSummaries(input.gapSummaries) : undefined,
          triggeringQuestionIds: input.triggeringQuestionIds,
          destinationId: input.destinationId,
          gapClusterId: input.gapClusterId,
          jobId: job.id,
          draftContext: buildDraftContext({
            gapSummaries: input.gapSummaries ?? [],
            sources: input.sources,
            evidence: input.evidence ?? [],
            openPullRequests: input.openPullRequests
          })
        },
        { jobId: job.id, jobType: job.type }
      )
    );
    ```
  - `createSeedProposalFromCompletedJob`, `createCorrectiveProposalFromCompletedJob`,
    and `createImproveProposalFromCompletedJob`: identically wrap the existing object
    literal argument, changing nothing inside it:
    ```ts
    return ctx.stores.proposals.create(
      flagAdvisoryDraft({ /* existing object literal unchanged */ }, { jobId: job.id, jobType: job.type })
    );
    ```

- [ ] Wire the regeneration branch. In `applyRegeneratedProposal` (same file), the
  markdown is applied via `recordRegeneration`, not `create`, so check it directly:

  ```ts
  async function applyRegeneratedProposal(
    ctx: AppContext,
    proposalId: string,
    output: DraftMarkdownProposalJobOutput
  ): Promise<void> {
    const headings = collectAdvisoryHeadings(output.markdown);
    let rationale = output.rationale;
    if (headings.length > 0) {
      logger.warn(
        { proposalId, advisoryHeadings: headings },
        "regenerated draft contains advisory-style headings; flagged on the proposal rationale (not blocked)"
      );
      rationale = `${rationale}\n\n${advisoryNote(headings)}`;
    }
    const updated = await ctx.stores.proposals.recordRegeneration(proposalId, output.markdown, rationale);
    if (!updated) {
      logger.warn({ proposalId }, "regeneration draft completed but its proposal is gone — skipping re-publish");
      return;
    }
    await enqueuePublishProposal(ctx, updated, { regenerate: true });
    logger.info(
      { proposalId, regenerationCount: updated.regenerationCount },
      "regenerated stale proposal against fresh base — re-publishing onto existing branch"
    );
  }
  ```

- [ ] Wire source-sync. In `apps/api/src/features/source-sync/service.ts`, add the
  import:

  ```ts
  import { flagAdvisoryDraft } from "../proposals/register-check.js";
  ```

  and in `attachSourceSyncPlanFromCompletedJob` change:

  ```ts
  const proposal = existing ?? await ctx.stores.proposals.create(sourceSyncProposalInput(completed, parsed.data, changeset, job));
  ```
  to
  ```ts
  const proposal =
    existing ??
    (await ctx.stores.proposals.create(
      flagAdvisoryDraft(sourceSyncProposalInput(completed, parsed.data, changeset, job), {
        jobId: job.id,
        jobType: job.type
      })
    ));
  ```

- [ ] Wire the fold appliers (log-only — folds rewrite the survivor's markdown, not its
  rationale, and any note the original draft earned is already on the surviving
  rationale). In `apps/api/src/scheduling/fold.ts`, add the import:

  ```ts
  import { collectAdvisoryHeadings } from "../features/proposals/register-check.js";
  ```

  In `applyFoldFromCompletedJob`, immediately after the `if (!survivor || !rival || rival.status === "superseded")` guard:

  ```ts
  const advisoryHeadings = collectAdvisoryHeadings(parsed.data.markdown);
  if (advisoryHeadings.length > 0) {
    logger.warn(
      { survivorId: survivor.id, rivalId: rival.id, jobId: job.id, advisoryHeadings },
      "folded markdown contains advisory-style headings (flagged, not blocked)"
    );
  }
  ```

  In `applyChangesetFoldFromCompletedJob`, immediately after the `primaryMarkdown` const:

  ```ts
  const advisoryHeadings = collectAdvisoryHeadings(primaryMarkdown, parsed.data.changeset);
  if (advisoryHeadings.length > 0) {
    logger.warn(
      { survivorId: survivor.id, rivalId: rival.id, jobId: job.id, advisoryHeadings },
      "folded changeset contains advisory-style headings (flagged, not blocked)"
    );
  }
  ```

- [ ] Run again: `npm run build && npm test -w @magpie/api` — all new tests pass and
  every pre-existing proposals/fold/source-sync test stays green (a clean draft flows
  through `flagAdvisoryDraft` unchanged by identity).

- [ ] Validate everything including knip: `npm run typecheck && npm run lint && npm run deadcode`
  — `findAdvisoryHeadings` (Task 4) is now consumed, and all three `register-check.ts`
  exports are imported by other files (`service.ts`, `source-sync/service.ts`, `fold.ts`).

- [ ] Commit:
  `git commit -am "feat(api): flag advisory-register drafts on the proposal rationale (#213)"`

---

### Task 6: documentation + full validation

`docs/ai-jobs.md` describes the drafting and seeding behaviour that this plan changes;
record the register contract, the `uncoveredPoints` reporting, and the register check.
(No other file under `docs/` states the "note the gap plainly" behaviour — the matches
under `docs/superpowers/` are historical plans/specs and are never retro-edited.)

**Files**
- `docs/ai-jobs.md` (edit)

**Interfaces** — none (prose only).

**Steps**

- [ ] In `docs/ai-jobs.md`, in the gap-drafting section, after the paragraph ending
  `…any \`targetPath\` returned by the provider is not used to place the file.`
  (around line 186), insert:

  ```markdown
  Drafts are register-constrained (#213): every content-producing prompt (gap drafts, seed
  drafts, both folds, source-sync rewrites, corrective rewrites, improve growth) carries a
  shared factual-register contract — documents state what the sources state, and never
  author their own recommendations, next steps, action items, roadmaps, or editorial
  commentary (describing a plan a *source itself states* remains allowed). Points the
  sources do not cover are **omitted from the document body** and reported in the draft
  output's optional `uncoveredPoints` field; the API logs a warning and folds them into
  the proposal's rationale so the reviewer sees what could not be supported. As a
  backstop, the API runs an advisory-heading check (`findAdvisoryHeadings` in
  `@magpie/markdown`) over every draft/rewrite/fold output it consumes: a draft containing
  headings like "Recommendations", "Next steps", "Action items", "Roadmap" or "Future
  work" is **flagged, never failed** — a structured log warning plus a "Register check:"
  note on the proposal rationale — because a document may legitimately describe a roadmap
  its source states.
  ```

- [ ] In the seeding section, after the sentence ending `…the job fails loudly rather
  than drafting an ungrounded document.` (around line 311), insert:

  ```markdown
  Coverage points the sources do not support are omitted from the authored document and
  come back in the output's `uncoveredPoints` field, which the API folds into the seed
  proposal's rationale (see the register constraint above).
  ```

- [ ] Full final validation, exactly the project gates:
  `npm run build && npm test && npm run typecheck && npm run lint && npm run format:check && npm run deadcode`
  — all green.

- [ ] Commit:
  `git commit -am "docs(ai-jobs): document the factual register, uncovered points, and register check (#213)"`

---

## Self-review against scope

- **Scope item 1** (register constraint in every content-producing prompt, shared
  constant like `CONSERVATIVE_CONTRACT`) → Task 1: `FACTUAL_REGISTER_CONTRACT` in the
  seven content-producing prompts, including the source-change-sync plan prompt (it
  rewrites document content).
- **Scope item 2** (remove "note the gap plainly" and equivalents; report uncovered
  points instead) → Task 2 (contract + prompt rewording for both drafting prompts —
  `DRAFT_MARKDOWN_PROPOSAL`'s "say so plainly" is the equivalent wording) and Task 3
  (consumption: warn + rationale). Mechanism and why documented in Task 2's rationale
  note.
- **Scope item 3** (pure detector + flag-not-fail wiring) → Task 4
  (`packages/markdown`, pure, fence-aware) and Task 5 (log warning + rationale note at
  every draft/rewrite consumption point; log-only at fold-apply; dedupe/split excluded
  with reasons).
- **Scope item 4** (tests + docs) → every task is TDD with real test code; Task 6
  updates `docs/ai-jobs.md`.
- **Out of scope honoured**: no citation instruction is touched anywhere (#214).
- **Consistency**: `uncoveredPoints?: string[]` is the same name in core, zod, prompts,
  and the API; `findAdvisoryHeadings` / `collectAdvisoryHeadings` / `advisoryNote` /
  `flagAdvisoryDraft` names match across Tasks 4–5; every export is consumed by another
  file (knip STRICT).
