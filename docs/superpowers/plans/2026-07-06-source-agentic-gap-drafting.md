# Source-Agentic Gap Drafting (Increment 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move gap drafting (`draft_markdown_proposal` / `draftFromGaps`) onto the source-agentic grounding model that increment 1 built for seeding — the job carries `SourceDescriptor[]` references instead of a blind file sample, and the watcher lets the agent explore the source checkout directly.

**Architecture:** Increment 1 already shipped all the heavy machinery — the descriptor contract, `apps/watcher/src/source-workspace.ts`, `source-tools.ts`, `buildSourceGroundedPrompt`, `runSourceAgentJob`, the CLI source-grounded mode, and the dispatch branch in both `CliRunner.run()` and `ChatRunner.run()` (`hasFsSources(sourceDescriptorsOf(job))`). This increment is therefore small and mostly a *contract swap*: (1) replace `sourceContext?: SourceDataContext[]` with `sources: SourceDescriptor[]` on the `draft_markdown_proposal` input; (2) rewire the two API enqueue sites to project descriptors via `projectSourceDescriptors` instead of sampling via `collectSourceContext*`; (3) give `DRAFT_MARKDOWN_PROPOSAL` the exploration prompt; (4) teach the watcher's `sourceDescriptorsOf` to recognise the job type — which lights up the existing dispatch automatically. No new runner code.

**Tech Stack:** TypeScript ESM/NodeNext, zod, node:test. Spec: `docs/superpowers/specs/2026-07-06-source-agentic-grounding-design.md` (increment 2). Reference implementation: increment 1 plan `docs/superpowers/plans/2026-07-06-source-agentic-seeding.md` and its landed commits.

## Global Constraints

- ESM/NodeNext: relative imports need explicit `.js` extensions, even from `.ts`.
- Never cast through `unknown`/`any` to silence types; no hacky workarounds.
- Tests: `node:test`, colocated `*.test.ts`. Run via `npm test -w <workspace>` (never root-cwd `node --test` — `@magpie/*` resolves to stale dist otherwise).
- Cross-package type changes need `npm run build` before dependent workspace tests.
- knip runs STRICT in CI (`npm run deadcode`): de-export anything unused, never relax the config.
- `npm run format:check` is **not** a CI gate (`.github/workflows/verify.yml` runs typecheck/test/lint/deadcode/build) and currently fails repo-wide under the lockfile'd prettier; do NOT run `prettier --write` across the repo.
- Commit and push after every task. UK English in docs and prompts.
- **Scope guard:** ONLY gap drafting migrates. `collectSourceContext` (the uncached fn) STAYS — patrols still call it at `apps/api/src/features/patrol/service.ts:264` and `:419`; it is deleted in increment 3. The `SourceDataContext` type STAYS (used by `collectSourceContext`, the patrol corpus store, and its tests). Only `collectSourceContextCached` and the `SourceContextCache` cache-plumbing become dead and are removed here (their sole users are the gap-drafting chain).
- In-flight `draft_markdown_proposal` jobs enqueued with the old `sourceContext` shape will fail schema validation after deploy — acceptable (single-operator; the reconciler re-enqueues).

---

### Task 1: Migrate the `draft_markdown_proposal` contract to source descriptors

**Files:**
- Modify: `packages/core/src/index.ts` (line 619: the `sourceContext?` field on `DraftMarkdownProposalJobInput`)
- Modify: `packages/jobs/src/schemas.ts` (line 169: `sourceContext` in `draftMarkdownProposalInputSchema`)
- Test: `packages/jobs/src/catalog.test.ts` (add a schema test, mirroring the seed test)

**Interfaces:**
- Produces (Tasks 2 & 4 consume): `DraftMarkdownProposalJobInput.sources: SourceDescriptor[]` (replaces `sourceContext`); the updated `draftMarkdownProposalInputSchema`. `SourceDescriptor` and `sourceDescriptorSchema` already exist (increment 1) — `sourceDescriptorSchema` is defined at `packages/jobs/src/schemas.ts:146` and already imported into scope; `SourceDescriptor` is exported from `@magpie/core`.

- [ ] **Step 1: Change the core type**

In `packages/core/src/index.ts`, replace the `sourceContext?` field of `DraftMarkdownProposalJobInput` (line 619):

```ts
  sourceContext?: SourceDataContext[];
```

with (keep every other field on the interface unchanged):

```ts
  // References to the flow's configured sources the drafter is grounded in — the
  // executing agent explores these checkouts directly (see the source-agentic
  // grounding spec). Replaces the old inline sourceContext file sample. git/local
  // resolve to traversable workspaces on the watcher; internet/agent render as
  // prompt notes only. Empty when the flow has no configured sources.
  sources: SourceDescriptor[];
```

`SourceDescriptor` is already exported from this file (increment 1). Leave the `SourceDataContext` interface (defined further down at line 658) in place — it is still used by `collectSourceContext` and the patrol corpus store.

- [ ] **Step 2: Write the failing schema test**

In `packages/jobs/src/catalog.test.ts` (match the existing test style; there is a sibling `draft_seed_document` descriptor test to mirror), add:

```ts
it("draft_markdown_proposal input carries source descriptors, not inline content", () => {
  const input = {
    provider: "openai-compatible",
    gapSummaries: ["how refunds are processed"],
    triggeringQuestions: ["What is the refund window?"],
    evidence: [],
    sources: [
      { id: "src-1", name: "Product repo", kind: "git", url: "https://example.com/repo.git", subpath: "Docs" },
      { id: "src-2", name: "Agent knowledge", kind: "agent" }
    ],
    expectedOutput: "markdown_proposal"
  };
  assert.equal(draftMarkdownProposalInputSchema.safeParse(input).success, true);
  const legacy = {
    provider: "openai-compatible",
    gapSummaries: ["x"],
    triggeringQuestions: [],
    evidence: [],
    sourceContext: [],
    expectedOutput: "markdown_proposal"
  };
  assert.equal(draftMarkdownProposalInputSchema.safeParse(legacy).success, false);
});
```

Ensure `draftMarkdownProposalInputSchema` is imported at the top of the test file (it is exported from `@magpie/jobs` via `schemas.ts:160`); add it to the existing import if not already present.

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run build && npm test -w packages/jobs`
Expected: the new test FAILS — the schema still has `sourceContext` (optional) and no `sources`, so the legacy shape parses (success `true`, assertion expects `false`) and `sources` is stripped.

- [ ] **Step 4: Update the jobs schema**

In `packages/jobs/src/schemas.ts`, inside `draftMarkdownProposalInputSchema`, replace line 169:

```ts
  sourceContext: z.array(sourceDataContextSchema).optional(),
```

with:

```ts
  // Mirrors @magpie/core SourceDescriptor. References only — no file content; the
  // watcher resolves git/local to traversable workspaces. Same schema the seed
  // input uses.
  sources: z.array(sourceDescriptorSchema),
```

`sourceDescriptorSchema` is already defined at line 146 in this file. The trailing `satisfies z.ZodType<ProviderInput<CoreDraftMarkdownProposalJobInput>>` clause (line 183) will now enforce agreement with the core type changed in Step 1. Do NOT remove `sourceDataContextSchema` — it is still used by the patrol/corpus schemas; verify with `grep -n "sourceDataContextSchema" packages/jobs/src/schemas.ts` before assuming it is dead.

- [ ] **Step 5: Run to verify it passes**

Run: `npm run build && npm test -w packages/jobs`
Expected: PASS (new test green; existing jobs suite green).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/jobs/src/schemas.ts packages/jobs/src/catalog.test.ts
git commit -m "feat(jobs): carry source descriptors on draft_markdown_proposal, not sampled content"
git push
```

---

### Task 2: Rewire the two gap-drafting enqueue sites and the draft-context consumer

**Files:**
- Modify: `apps/api/src/features/proposals/service.ts` (imports ~line 46–48; `buildDraftContext` 1144–1158; `draftFromGaps` overrides type ~1168 + body 1226–1274; `buildRegenerationDraftInput` 1001–1023; `createProposalFromCompletedJob` 1346–1352)
- Modify: `apps/api/src/features/gaps/service.ts` (remove `SourceContextCache` plumbing at lines 4, 62, 83)
- Modify: `apps/api/src/scheduling/gap-reconciler.ts` (remove `SourceContextCache` plumbing at lines 11, 509, 517)
- Modify existing tests: `apps/api/src/features/jobs/service.test.ts` (fixtures ~268, ~300), `apps/api/src/features/jobs/fold-dispatch.test.ts` (~7), `apps/api/src/scheduling/gap-reconciler.test.ts` (~579), `apps/api/src/features/proposals/link-cluster.test.ts` (~16), `apps/api/src/features/proposals/service.test.ts` (draftFromGaps assertions ~1099–1210)

**Interfaces:**
- Consumes: `projectSourceDescriptors(deps: RepositoryDeps, sourceIds: string[] | undefined): SourceDescriptor[]` (from `apps/api/src/platform/source-descriptors.ts`, increment 1). Selection semantics are identical to the old sampler (explicit ids filter; else first three configured sources) — a like-for-like swap.
- Produces: both enqueue sites emit `sources` on the `draft_markdown_proposal` input; `draftFromGaps` no longer accepts a `sourceContextCache` override.

- [ ] **Step 1: Swap the imports**

In `apps/api/src/features/proposals/service.ts`, find the import of the sampler (around lines 46–48) — it imports `collectSourceContext`, `collectSourceContextCached`, and the `SourceContextCache` type. Remove that import entirely. Add:

```ts
import { projectSourceDescriptors } from "../../platform/source-descriptors.js";
```

Also change the type import used by `buildDraftContext`: replace `SourceDataContext` with `SourceDescriptor` in the `@magpie/core` import at the top of the file (grep `SourceDataContext` in this file — after this task `buildDraftContext` is its only user, and it becomes a `SourceDescriptor` consumer, so the `SourceDataContext` import becomes unused and must go; `SourceDescriptor` is already exported from `@magpie/core`).

- [ ] **Step 2: Re-point `buildDraftContext` to descriptors**

Replace `buildDraftContext` (lines 1144–1158) with (it records source *identities* for inspection — now the descriptors that grounded the draft, not sampled files):

```ts
// Distils the inputs handed to the drafter into the compact, inspectable record
// kept on the proposal. Records the source identities (name + git url / local
// path / internet url) that grounded the draft — not their file bodies, which the
// agent read directly and which are large.
function buildDraftContext(parts: {
  gapSummaries: string[];
  sources?: SourceDescriptor[];
  evidence: Proposal["evidence"];
  openPullRequests?: OpenPullRequestContext[];
}): DraftContext {
  return {
    gapSummaries: parts.gapSummaries,
    sourceFiles: (parts.sources ?? []).map((source) => ({
      sourceName: source.name,
      path: source.kind === "local" ? source.path : undefined,
      url: source.kind === "git" || source.kind === "internet" ? source.url : undefined
    })),
    evidenceCount: parts.evidence.length,
    openPullRequests: parts.openPullRequests ?? []
  };
}
```

Note: `git` descriptors always have `url`; `internet` has `url?` (may be `undefined`); `local` has `path`; `agent` has neither (both `undefined`). The `DraftContext.sourceFiles` element type already accepts optional `path`/`url` (the old code mapped exactly those fields). If the compiler complains that `url`/`path` must be present, check the `DraftContext` type definition and keep them optional there — do not force non-null.

- [ ] **Step 3: Rewire `draftFromGaps`**

In `draftFromGaps` (`apps/api/src/features/proposals/service.ts`):

1. In the `overrides` parameter type (around line 1168), remove the `sourceContextCache?: SourceContextCache;` field.
2. Replace the source-context line (around line 1238):

```ts
  const sourceContext = await collectSourceContextCached(deps, sourceIds, overrides.sourceContextCache);
```

with:

```ts
  const sources = projectSourceDescriptors(deps, sourceIds);
```

(`deps` is `ctx.repositoryDeps()` at ~line 1221; `sourceIds` is `overrides.sourceIds ?? flow?.sourceIds` at ~line 1227 — both already in scope.)

3. In the input object literal (lines 1253–1269), change the `sourceContext` field to `sources`:

```ts
    sources,
```

(replacing `sourceContext,`). Leave every other field unchanged.

- [ ] **Step 4: Rewire `buildRegenerationDraftInput`**

In `buildRegenerationDraftInput` (`apps/api/src/features/proposals/service.ts`, ~lines 1001–1023):

1. Replace (around line 1005):

```ts
  const sourceContext = await collectSourceContext(deps, sourceIds);
```

with (keep the "fresh read against the current base" intent in the comment above it — descriptor projection is cheap and always fresh, so no cache concern):

```ts
  const sources = projectSourceDescriptors(deps, sourceIds);
```

2. In the returned object literal (~lines 1009–1023), change `sourceContext,` to `sources,`.

- [ ] **Step 5: Re-point the completion handler**

In `createProposalFromCompletedJob` (`apps/api/src/features/proposals/service.ts`, ~line 1346–1352), change the `buildDraftContext` call argument from:

```ts
      sourceContext: input.sourceContext,
```

to:

```ts
      sources: input.sources,
```

(`input` is typed `Partial<DraftMarkdownProposalJobInput> & { … }`, so `input.sources` is `SourceDescriptor[] | undefined` — matches `buildDraftContext`'s optional `sources?`.)

- [ ] **Step 6: Remove the dead cache plumbing**

The `SourceContextCache` type and the shared-cache threading now have no users (their only consumer was `draftFromGaps`). Remove:

- `apps/api/src/features/gaps/service.ts`: the `SourceContextCache` import (line 4); the `sourceContextCache?: SourceContextCache` field on `draftFromCluster`'s overrides param (~line 62); and stop passing it through to `draftFromGaps` (~line 83 — drop `sourceContextCache` from the forwarded overrides object).
- `apps/api/src/scheduling/gap-reconciler.ts`: the `SourceContextCache` import (line 11); the shared `new Map()` cache construction (~line 509); and the `sourceContextCache` argument passed to `draftFromCluster` (~line 517).

Grep to confirm no `SourceContextCache` or `sourceContextCache` references remain outside `apps/api/src/platform/source-context.ts` (where the type is defined and stays for now — increment 3 deletes it):

```bash
rg -n "SourceContextCache|sourceContextCache" apps/api/src | rg -v "platform/source-context.ts"
```

Expect no hits. (knip will also flag `collectSourceContextCached` as unused; it is exported from `source-context.ts` — de-export it there, i.e. remove the `export` keyword or the function if truly dead. Verify with `rg -n "collectSourceContextCached" apps/api/src` first: after this task its only definition site remains. Remove the export.)

- [ ] **Step 7: Update the affected test fixtures**

`sources` is now a required field on `DraftMarkdownProposalJobInput`. The following fixtures construct that input as a typed literal and omit `sources` — add `sources: []` to each (an empty array keeps them on the non-agentic one-shot path, which is what these tests exercise):

- `apps/api/src/features/jobs/service.test.ts` — the two `draft_markdown_proposal` input fixtures (~lines 268–274 and ~300–306).
- `apps/api/src/features/jobs/fold-dispatch.test.ts` — the `draftInput` fixture (~lines 7–13).
- `apps/api/src/scheduling/gap-reconciler.test.ts` — the `draftInputFor` fixture (~lines 579–586).
- `apps/api/src/features/proposals/link-cluster.test.ts` — the draft input fixture (~lines 16–22).

For each, add the field, e.g.:

```ts
  sources: [],
```

Then in `apps/api/src/features/proposals/service.test.ts`, the `draftFromGaps` tests parse the enqueued input against `jobDefinition("draft_markdown_proposal").inputSchema` (~lines 1129, 1167). These now require `sources`. Add an assertion in the primary `draftFromGaps` test that the enqueued input carries projected descriptors — construct the test's flow config with at least one `git` or `local` source and assert:

```ts
assert.ok(Array.isArray(enqueued.sources));
assert.deepEqual(enqueued.sources.map((s) => s.id), [/* the configured source ids selected */]);
```

Read the existing test's flow/deps setup (how it builds `knowledgeConfig.sources` and `sourceIds`) and match the expected ids to that fixture; if the existing test's flow has no configured sources, `sources` will be `[]` and the assertion is `assert.deepEqual(enqueued.sources, [])`.

- [ ] **Step 8: Run everything**

Run: `npm run build && npm test -w apps/api && npm run typecheck && npm run lint && npm run deadcode`
Expected: all PASS. If knip flags `collectSourceContextCached` or `SourceContextCache`, de-export/remove them in `source-context.ts` (Step 6) — but do NOT touch `collectSourceContext` or `SourceDataContext`, which patrols and the corpus store still use (`rg -n "collectSourceContext\b|SourceDataContext" apps/api/src` to confirm remaining callers before deciding).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(proposals): ground gap drafting in source descriptors, drop the sampler cache"
git push
```

---

### Task 3: Exploration-grounded `DRAFT_MARKDOWN_PROPOSAL` prompt

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (`DRAFT_MARKDOWN_PROPOSAL`, lines 113–139)
- Test: `packages/prompts/src/catalog.test.ts` (fix any instruction-text assertion that pins the old wording)

**Interfaces:**
- Consumes nothing new. The watcher's `buildSourceGroundedPrompt` already reads `JOB_INSTRUCTIONS["draft_markdown_proposal"]` (wired at `apps/watcher/src/job-prompts.ts:79`) and prepends the workspace listing + tool vocabulary, so updating the catalog text is sufficient — no watcher prompt change.

- [ ] **Step 1: Rewrite the instructions**

In `packages/prompts/src/catalog.ts`, update `DRAFT_MARKDOWN_PROPOSAL`. Change its `description` to note agentic grounding, and replace the `instructions` template — add an exploration/grounding preamble (mirroring `DRAFT_SEED_DOCUMENT`), replace the old "Use sourceContext when present as raw material…" line (line 127) with the exploration contract, and KEEP the gap-specific rules verbatim (the `gapSummaries` cohesion rule, `resubmissionNotes`, `openPullRequests`, citations, frontmatter, JSON-only):

```ts
export const DRAFT_MARKDOWN_PROPOSAL: PromptDefinition = {
  id: "draft-markdown-proposal",
  title: "Draft Markdown proposal",
  description:
    "Drafts a single cohesive Markdown article that addresses every listed gap, grounded in the flow's source repositories, which the executing agent explores directly. Used by the watcher's draft_markdown_proposal job.",
  usedBy: ["watcher"],
  outputShape: "{ title, targetPath, markdown, rationale }",
  instructions: `Draft a single Markdown knowledge base proposal that addresses every gap listed in gapSummaries, grounded in the source repositories you have been given access to.

Grounding:
- You have DIRECT access to the source repositories listed in the prompt. Explore them: list directories to learn the structure, search for terms from the gap summaries and triggering questions, open the files that matter, and follow references between files. Do not stop at the first file — corroborate across the codebase and docs.
- Ground every factual claim in files you actually read, and cite their repository paths (e.g. "(see Docs/Specifications/Statements/ingestion.md)").
- Never introduce assertions the sources do not support. Do not fabricate figures, dates, or APIs. Where the sources genuinely do not cover a point, write only what can be supported and say so plainly.

Rules:
- Return JSON only.
- gapSummaries may contain several related gaps; write ONE cohesive article that covers all of them rather than separate sections that repeat each other.
- The input may include resubmissionNotes: this is a re-draft because a previous proposal merged but still did NOT answer the triggering questions. Each note explains what was already published and why it fell short. Treat these as the most important guidance — directly address the specific shortfall each note calls out (add the missing specifics, examples, or coverage) rather than restating what the earlier attempt already contained.
- The input may include openPullRequests: the flow's already in-flight proposals and currently open pull requests, each with a title, an optional url, and a target path. Do NOT draft something that duplicates one of these. If your article overlaps an open pull request, build on it and reference it (by title and url) in the rationale instead of restating its content; draft only what those in-flight changes leave uncovered.
- Markdown must be reviewable and conservative; UK English. Include frontmatter with title and status: draft.
- Cite source file paths, URLs, or agent/internet source names in the rationale.

Return JSON:
{
  "title": "string",
  "targetPath": "string",
  "markdown": "string",
  "rationale": "string"
}`
};
```

- [ ] **Step 2: Run the prompts tests and fix pinned wording**

Run: `npm test -w packages/prompts`
Expected: PASS. If any assertion in `catalog.test.ts` pinned the old `sourceContext` sentence or the old opening line, update it to match the new text (search the test for `sourceContext` and for `DRAFT_MARKDOWN_PROPOSAL` / `draft-markdown-proposal`).

- [ ] **Step 3: Rebuild and re-run the watcher prompt tests**

Run: `npm run build && npm test -w apps/watcher`
Expected: PASS — `buildSourceGroundedPrompt` and `buildPrompt` both read the updated instructions; confirm no `job-prompts.test.ts` assertion pinned the old `draft_markdown_proposal` wording.

- [ ] **Step 4: Commit**

```bash
git add packages/prompts/src/catalog.ts packages/prompts/src/catalog.test.ts
git commit -m "feat(prompts): exploration-grounded draft_markdown_proposal instructions"
git push
```

---

### Task 4: Light up the watcher agentic path for `draft_markdown_proposal`

**Files:**
- Modify: `apps/watcher/src/source-workspace.ts` (`sourceDescriptorsOf`, lines 28–37)
- Test: `apps/watcher/src/source-workspace.test.ts` (extend)
- Test: `apps/watcher/src/runners/chat.test.ts` and/or `apps/watcher/src/runners/cli.test.ts` (confirm dispatch)

**Interfaces:**
- Consumes: `draftMarkdownProposalInputSchema` from `@magpie/jobs` (Task 1).
- Produces: `sourceDescriptorsOf(job)` returns the descriptors for a `draft_markdown_proposal` job (in addition to `draft_seed_document`). The dispatch branches in `CliRunner.run()` and `ChatRunner.run()` already call `hasFsSources(sourceDescriptorsOf(job))`, so this is the only change needed to activate the agentic path — no runner edit.

- [ ] **Step 1: Write the failing test**

In `apps/watcher/src/source-workspace.test.ts`, extend the `sourceDescriptorsOf` describe block:

```ts
it("returns descriptors for a draft_markdown_proposal job", () => {
  const job = {
    id: "j2",
    type: "draft_markdown_proposal",
    input: {
      provider: "openai-compatible",
      gapSummaries: ["refunds"],
      triggeringQuestions: [],
      evidence: [],
      sources: [{ id: "s1", name: "Repo", kind: "git", url: "https://example.com/r.git" }],
      expectedOutput: "markdown_proposal"
    }
  } as JobView;
  assert.deepEqual(sourceDescriptorsOf(job).map((s) => s.id), ["s1"]);
});

it("returns [] for a malformed draft_markdown_proposal input", () => {
  const job = { id: "j3", type: "draft_markdown_proposal", input: { provider: "openai-compatible" } } as JobView;
  assert.deepEqual(sourceDescriptorsOf(job), []);
});
```

(Match the existing helper/import style in the file; `JobView` is already imported.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npm test -w apps/watcher`
Expected: FAIL — `sourceDescriptorsOf` returns `[]` for `draft_markdown_proposal` (it only handles `draft_seed_document`).

- [ ] **Step 3: Implement**

In `apps/watcher/src/source-workspace.ts`, update the import and `sourceDescriptorsOf` (lines 5 and 28–37):

```ts
import { draftMarkdownProposalInputSchema, draftSeedDocumentInputSchema, type JobView } from "@magpie/jobs";
```

```ts
// The source descriptors of a source-grounded job, [] for every other job type.
// Increments 1–2: seeding and gap drafting; increment 3 adds the patrol jobs here.
export function sourceDescriptorsOf(job: JobView): SourceDescriptor[] {
  if (job.type === "draft_seed_document") {
    const parsed = draftSeedDocumentInputSchema.safeParse(job.input);
    return parsed.success ? parsed.data.sources : [];
  }
  if (job.type === "draft_markdown_proposal") {
    const parsed = draftMarkdownProposalInputSchema.safeParse(job.input);
    return parsed.success ? parsed.data.sources : [];
  }
  return [];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w apps/watcher`
Expected: PASS (new tests + existing suite green).

- [ ] **Step 5: Add a dispatch test proving the agentic path activates**

In `apps/watcher/src/runners/cli.test.ts` (source-grounded describe block), add a test mirroring the existing seed dispatch test but for a `draft_markdown_proposal` job with a `local`/`git` source — assert it spawns with the read-only flags and cwd = the workspace root (i.e. it went through `runSourceGrounded`, not the generative path). Reuse the file's `fakeSpawn`/`prepareWorkspaces` seams and `SEED_OUTPUT_JSON` (the output schema for both jobs is `{title,targetPath,markdown,rationale}`, so the same fixture parses). Build the job with:

```ts
function proposalJob(provider: "codex" | "claude"): JobView {
  return job("draft_markdown_proposal", {
    provider,
    gapSummaries: ["refunds"],
    triggeringQuestions: [],
    evidence: [],
    sources: [{ id: "s1", name: "Repo", kind: "local", path: "unused-here" }],
    expectedOutput: "markdown_proposal"
  });
}
```

Then assert `calls[0].cwd` is the primary workspace root and the read-only args are present (same assertions as the seed test).

- [ ] **Step 6: Run and commit**

Run: `npm run build && npm test -w apps/watcher && npm run typecheck && npm run lint && npm run deadcode`
Expected: PASS.

```bash
git add -A
git commit -m "feat(watcher): route draft_markdown_proposal through the source-agentic path"
git push
```

---

### Task 5: End-to-end validation and docs

**Files:**
- Modify: `docs/ai-jobs.md`, `docs/architecture.md`
- Modify: `.claude/skills/magpie-orientation/SKILL.md`

- [ ] **Step 1: Full validation suite**

Run, in order: `npm run build && npm run typecheck && npm run lint && npm test && npm run deadcode`
Expected: all PASS. (Skip `format:check` — see Global Constraints. `test:db` needs Docker/Postgres; run it only if the environment has `DOCKER_HOST` configured per the writing-magpie-tests skill.)

- [ ] **Step 2: Grep for stale references**

Run: `rg -n "sourceContext" apps/api/src/features/proposals packages/prompts`
Expect no hits (proposals no longer sample; the prompt no longer mentions `sourceContext`). Any remaining `sourceContext`/`collectSourceContext`/`SourceDataContext` hits should be ONLY in `apps/api/src/features/patrol/`, `apps/api/src/platform/source-context.ts`, `apps/api/src/stores/source-corpus-store.ts`, and `packages/core/src/index.ts` (the surviving type + patrol machinery) — confirm with `rg -n "collectSourceContext\b|SourceDataContext" apps/api/src`.

- [ ] **Step 3: Update docs**

- `docs/ai-jobs.md`: update the gap-drafting / `draft_markdown_proposal` description — its input now carries `sources: SourceDescriptor[]` (not `sourceContext`), and execution is agentic (CLI tier traverses the read-only checkout; HTTP tier runs the bounded tool loop), identical to seeding. Note it shares the `MAGPIE_AGENTIC_TIMEOUT_MS` timeout. If the doc describes the gap→draft→reconcile pipeline, add one sentence that drafting is now source-grounded like seeding.
- `docs/architecture.md`: in the watcher/checkout section, note that gap drafting (not just seeding) now resolves source descriptors to read-only workspaces and no longer samples sources API-side. Reference the spec.
- `.claude/skills/magpie-orientation/SKILL.md`: extend the "Seeding is agentic and source-grounded" bullet (added in increment 1) to say gap drafting (`draft_markdown_proposal`) now uses the same model; do not restructure the skill.

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "docs: source-agentic gap drafting — job contract, architecture, orientation notes"
git push
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --base main --title "feat: source-agentic grounding for gap drafting (increment 2)" --body "Implements increment 2 of docs/superpowers/specs/2026-07-06-source-agentic-grounding-design.md: draft_markdown_proposal carries source descriptors instead of a blind file sample; draftFromGaps and the regeneration path project descriptors via projectSourceDescriptors; the DRAFT_MARKDOWN_PROPOSAL prompt gains the exploration contract; the watcher routes the job through the source-agentic tiers built in increment 1 (no new runner code). Removes the now-dead collectSourceContextCached/SourceContextCache cache plumbing (collectSourceContext itself stays for patrols until increment 3). Increment 3 (patrols + sampler demolition) follows."
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** increment 2 = "gap drafting — draft_markdown_proposal / draftFromGaps moves over." Task 1 (contract), Task 2 (both enqueue sites + draft-context consumer + cache removal), Task 3 (prompt), Task 4 (watcher activation), Task 5 (validation/docs/PR) cover it. Patrol jobs and sampler *deletion* are explicitly out of scope (increment 3).
- **Scope guard reminder:** `collectSourceContext` (uncached) and `SourceDataContext` STAY — patrols and the corpus store use them. Only `collectSourceContextCached` + `SourceContextCache` are removed.
- **Type consistency:** `sources: SourceDescriptor[]` (required) on both core type and jobs schema; `projectSourceDescriptors(deps, sourceIds)` returns exactly that; `buildDraftContext` takes `sources?: SourceDescriptor[]`; `sourceDescriptorsOf` returns `SourceDescriptor[]`. `sourceDescriptorSchema` (jobs) and `SourceDescriptor` (core) are the increment-1 definitions, reused unchanged.
- **Line numbers are from main at the time of writing** — verify with a quick grep before editing each site, as unrelated edits may shift them.
