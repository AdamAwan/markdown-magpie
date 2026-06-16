# Shared Prompt Catalog + Read-Only UI Page

**Date:** 2026-06-17
**Status:** Approved (design)

## Problem

The AI/agent prompts used by Markdown Magpie are scattered and partly duplicated:

- The **watcher** (queue mode) has a central `apps/watcher/src/job-prompts.ts` with template
  functions that bake instructions + serialised input into a single string.
- The **API** (direct mode) defines parallel prompts inline as `system:` strings inside feature
  service files (`crunch`, `proposals`, `gaps`).
- The **retrieval** package defines the direct answer prompt inline.

Because queue mode and direct mode each have their own copy of some prompts, the two have drifted.
There is also no way to see the prompts without reading the source.

## Goal

1. Pull every prompt into one shared, importable catalog (single source of truth) so the existing
   call sites import from it and keep working — "used where they are".
2. Expose that catalog read-only via the API so a new UI page can display it.
3. Consolidate the genuine cross-mode duplicates into one definition each, where it is safe to do so.

Read-only display only. Prompts remain defined in code (not the database); the UI does not edit them.

## Prompt inventory (current state)

| # | Prompt | Defined now | Mode / consumer |
|---|--------|-------------|-----------------|
| 1 | `answer_question` (rich, model-produced citations) | `watcher/job-prompts.ts` `answerQuestionPrompt` | queue |
| 2 | `answer_question` (code-produced citations) | `retrieval/index.ts` `answerQuestion` system string | direct |
| 3 | `summarize_gap` | `watcher/job-prompts.ts` `summarizeGapPrompt` | queue |
| 4 | `draft_markdown_proposal` | `watcher/job-prompts.ts` + `api/proposals/service.ts` | queue **and** direct |
| 5 | `crunch_knowledge_base` | `watcher/job-prompts.ts` + `api/crunch/service.ts` | queue **and** direct |
| 6 | `gap_clustering` | `api/gaps/service.ts` `requestGapClusters` | direct |
| 7 | `generic_job` (fallback) | `watcher/job-prompts.ts` `genericPrompt` | queue |
| 8 | `job_runner_system` ("You complete Markdown Magpie AI jobs…") | `watcher/main.ts:159` | queue runner |

## Consolidation decisions

The genuinely-shared, engineered artefact is the **instruction text** (the prompt minus the
runtime data). Queue mode wraps it as `instructions + serialised input`; direct mode passes it as
the `system` field with the data in a separate user message.

- **#4 `draft_markdown_proposal`** and **#5 `crunch_knowledge_base`**: the two copies target the
  **identical JSON output contract**, only worded differently. These consolidate into one shared
  definition each. The richer/more-specific wording (currently the watcher's) becomes canonical.
- **#1 vs #2 `answer_question`**: **NOT merged.** Different output contracts — the queue prompt
  asks the model to produce citations; the direct path computes citations from search-ranking in
  code and only asks the model for `{answer, confidence, isKnowledgeGap, gaps}`. Merging would
  require relocating citation assembly (out of scope, risky). Both stay as separate catalog entries,
  each documenting why it differs. (A future task may unify them.)
- **#3 `summarize_gap`** vs **#6 `gap_clustering`**: genuinely different tasks, not duplicates. Both
  catalogued as-is.

Final catalog: **8 entries**, of which crunch + draft become single shared definitions used by both
queue and direct modes.

## Architecture

### New package `@magpie/prompts`

- Depends only on `@magpie/core` (for job input types). Imported by `api`, `watcher`, `retrieval`.
- Build order: `core → prompts → retrieval/markdown/git/jobs → api/watcher`.
- Standard package wiring: `package.json` (`main`/`types`/`build`/`typecheck`), `tsconfig.json`
  (extends base, `outDir: dist`, `rootDir: src`), `tsconfig.build.json` (clears `paths`), entry in
  root `tsconfig.base.json` `paths`, `file:` dependency added to `api`/`watcher`/`retrieval`
  `package.json`, and to the ordered root build script.

### Prompt definition shape

```ts
interface PromptDefinition {
  id: string;            // stable kebab id, e.g. "crunch-knowledge-base"
  title: string;         // human-readable title
  description: string;   // what the prompt is for
  usedBy: string[];      // e.g. ["watcher · queue mode", "api · direct mode"]
  outputShape: string;   // short description of the JSON the model must return
  instructions: string;  // canonical instruction text (NO baked-in data) — single source of truth
}
```

Builders keep call-site behaviour identical:

- `buildJobPrompt(def, input)` → `` `${def.instructions}\n\nInput:\n${JSON.stringify(input, null, 2)}` ``
  for queue mode. (For `answer_question` queue, the existing template embeds `question` and `context`
  separately; the builder reproduces today's exact layout for that entry.)
- Direct call sites import `def.instructions` straight into the `system` field — exactly today's shape.

Exports: `promptCatalog` (array of all definitions), `getPrompt(id)`, the per-task instruction
constants / definitions, and `buildJobPrompt`.

### Serialisation boundary

The catalog is plain data (no functions on `PromptDefinition`), so the API can serialise it directly.
Builders are standalone functions, not methods, so they are never serialised.

## Call-site refactors ("used where they are")

- `watcher/job-prompts.ts`: `buildPrompt(job)` becomes a dispatcher that looks up the definition by
  job type and calls `buildJobPrompt`. Inline template functions are removed. `parseJobOutput` and
  the `assert*` validators stay where they are (they are output validation, not prompts).
- `watcher/main.ts`: the `job_runner_system` literal moves to the catalog and is imported.
- `api/crunch/service.ts`, `api/proposals/service.ts`, `api/gaps/service.ts`: replace inline `system:`
  strings with the imported `instructions`.
- `retrieval/index.ts`: replace the inline answer system string with the imported
  `answer_question (direct)` instructions.

No behaviour change except the deliberate crunch/draft wording unification.

## API endpoint

New feature module `apps/api/src/features/prompts/` following the existing Hono pattern
(`routes.ts`, service if needed). `GET /api/prompts` returns
`{ prompts: PromptDefinition[] }` (the serialisable catalog). Read-only, no parameters. Mounted in
`apps/api/src/app.ts` alongside the other feature routers.

## UI page

New `"prompts"` section in the single-page console (`apps/web/src/app/page.tsx`), following the
existing convention:

1. Add `"prompts"` to the `ConsoleSection` union.
2. Add a `NavButton` in the sidebar calling `openSection("prompts")`.
3. Add a `PromptsPanel` function component that fetches `/prompts` via `apiGet` and renders each
   prompt as a card: title, description, "used by" chips, output shape, and the instruction text in a
   read-only monospace block.
4. Add the conditional render `{activeSection === "prompts" ? <PromptsPanel … /> : null}`.
5. Add entries to `sectionTitle()` and `sectionSubtitle()`.
6. Add CSS to `apps/web/src/app/styles.css` following the existing `.componentName` pattern.

Data is loaded when the section is opened (or folded into the existing `refresh()` — implementation
detail for the plan).

## Error handling

The endpoint serves a static in-memory catalog, so there are no domain error cases beyond the
standard global handler. The UI shows a loading state while fetching and a simple error message if
the request fails, consistent with other panels.

## Testing

- `@magpie/prompts` unit tests: all ids unique; every `AiJobType` maps to a definition;
  `buildJobPrompt` output contains both the instructions and the serialised input; the
  `answer_question` queue builder reproduces the current layout.
- API: smoke test for `GET /api/prompts` (returns the expected number of prompts with required fields).
- Existing watcher / api / retrieval tests must remain green (behaviour preserved; mock-provider
  paths do not exercise prompt text).

## Out of scope

- Editing prompts at runtime / storing them in the database.
- Unifying the two `answer_question` variants (deferred to a future task).
- Any change to model providers, embeddings, or job execution flow.
