# Shared Prompt Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every AI/agent prompt into one shared `@magpie/prompts` package used by the watcher, API, and retrieval, and expose the catalog read-only via `GET /api/prompts` for a new console "Prompts" section.

**Architecture:** A new workspace package holds each prompt as a pure-data `PromptDefinition` (the engineered *instruction text*, no runtime data). Queue mode wraps the instructions with serialised job input via `buildJobPrompt`; direct-mode call sites pass `def.instructions` as the chat `system` field. The API serialises the catalog array directly; the Next.js console fetches and renders it.

**Tech Stack:** TypeScript (NodeNext, strict), npm workspaces, Hono (API), Next.js App Router (web), `node:test` + `tsx` (tests).

## Global Constraints

- TypeScript strict mode; target ES2022; module NodeNext. Never cast through `unknown`.
- Package wiring mirrors existing packages exactly: `package.json` (`main: dist/index.js`, `types: dist/index.d.ts`, `build`/`typecheck` scripts), `tsconfig.json` (extends `../../tsconfig.base.json`, `outDir: dist`, `rootDir: src`), `tsconfig.build.json` (clears `paths`).
- Workspace import alias: `@magpie/prompts`. Internal package imports use `.js` extensions (NodeNext).
- Behaviour must be preserved at every call site. The ONLY intentional change is unifying the `crunch_knowledge_base` and `draft_markdown_proposal` instruction wording onto the richer (watcher) version — and mock-provider test paths do not exercise prompt text.
- `PromptDefinition` objects contain NO functions (must be JSON-serialisable for the API).
- Instruction strings in the catalog must NOT include a trailing newline; `buildJobPrompt` appends `\n\n…` so the queue output is byte-identical to today's prompts.
- Catalog order and ids are fixed (see Task 1). Exactly 8 entries.

---

### Task 1: Scaffold `@magpie/prompts` package with the catalog

**Files:**
- Create: `packages/prompts/package.json`
- Create: `packages/prompts/tsconfig.json`
- Create: `packages/prompts/tsconfig.build.json`
- Create: `packages/prompts/src/types.ts`
- Create: `packages/prompts/src/catalog.ts`
- Create: `packages/prompts/src/index.ts`
- Create (test): `packages/prompts/src/catalog.test.ts`
- Modify: `tsconfig.base.json` (add path alias)
- Modify: `package.json` (root build script ordering)

**Interfaces:**
- Produces: `interface PromptDefinition { id: string; title: string; description: string; usedBy: string[]; outputShape: string; instructions: string }`; `promptCatalog: PromptDefinition[]` (8 entries); named const definitions `ANSWER_QUESTION_QUEUE`, `ANSWER_QUESTION_DIRECT`, `SUMMARIZE_GAP`, `DRAFT_MARKDOWN_PROPOSAL`, `CRUNCH_KNOWLEDGE_BASE`, `GAP_CLUSTERING`, `GENERIC_JOB`, `JOB_RUNNER_SYSTEM`; `getPrompt(id: string): PromptDefinition | undefined`.
- Consumes: nothing (this package depends only on `@magpie/core` for types in a later task; the catalog itself needs no core imports).

- [ ] **Step 1: Create `packages/prompts/package.json`**

```json
{
  "name": "@magpie/prompts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "node --import tsx --test \"src/**/*.test.ts\"",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@magpie/core": "file:../core"
  },
  "devDependencies": {
    "@types/node": "^25.9.3",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3"
  }
}
```

- [ ] **Step 2: Create `packages/prompts/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create `packages/prompts/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "paths": {}
  },
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 4: Create `packages/prompts/src/types.ts`**

```ts
export interface PromptDefinition {
  /** Stable kebab-case identifier, e.g. "crunch-knowledge-base". */
  id: string;
  /** Human-readable title shown in the UI. */
  title: string;
  /** What the prompt is for. */
  description: string;
  /** Where this prompt is used, e.g. ["watcher · queue mode", "api · direct mode"]. */
  usedBy: string[];
  /** Short description of the JSON the model must return. */
  outputShape: string;
  /** Canonical instruction text (no runtime data baked in). Single source of truth. */
  instructions: string;
}
```

- [ ] **Step 5: Create `packages/prompts/src/catalog.ts`**

Note: each `instructions` value ends WITHOUT a trailing newline. Copy the text exactly.

```ts
import type { PromptDefinition } from "./types.js";

export const ANSWER_QUESTION_QUEUE: PromptDefinition = {
  id: "answer-question-queue",
  title: "Answer question (queue mode)",
  description:
    "Answers a question from Markdown context and asks the model to produce its own citations. Used by queued answer_question jobs.",
  usedBy: ["watcher · queue mode"],
  outputShape: '{ answer, confidence, citations[], gaps[] }',
  instructions: `You are answering a question using a Markdown knowledge base.

Rules:
- Use only the provided context.
- If the context is insufficient, say that reliable source material was not found.
- Return JSON only. Do not wrap it in Markdown.
- Every citation must refer to a provided context section.

Return this JSON shape:
{
  "answer": "string",
  "confidence": "high | medium | low",
  "citations": [
    {
      "documentId": "string",
      "sectionId": "string",
      "path": "string",
      "heading": "string",
      "anchor": "string",
      "excerpt": "string"
    }
  ],
  "gaps": [
    {
      "summary": "string",
      "question": "string",
      "confidence": "low",
      "citedSectionIds": []
    }
  ]
}

List one entry in "gaps" for each distinct piece of missing knowledge — a question that asks
about several unrelated topics should produce one gap per unanswered topic. Use an empty array
or omit "gaps" when the answer is fully supported by context.`
};

export const ANSWER_QUESTION_DIRECT: PromptDefinition = {
  id: "answer-question-direct",
  title: "Answer question (direct mode)",
  description:
    "Answers a question from Markdown context; citations are computed in code from search ranking, so the model only returns answer/confidence/gap detection. Used by the retrieval answerQuestion path.",
  usedBy: ["api · direct mode (retrieval)"],
  outputShape: '{ answer, confidence, isKnowledgeGap, gaps[] }',
  instructions:
    'Answer using only the provided Markdown knowledge base context. Return only JSON with this shape: ' +
    '{"answer":"string","confidence":"high|medium|low","isKnowledgeGap":true|false,"gaps":["string"]}. ' +
    'Set isKnowledgeGap to true and confidence to low when the context does not specifically answer the question. ' +
    'List each distinct piece of missing knowledge as its own entry in "gaps" — a question that asks about several ' +
    'unrelated topics should produce one gap per unanswered topic. Use an empty array when the answer is fully supported.'
};

export const SUMMARIZE_GAP: PromptDefinition = {
  id: "summarize-gap",
  title: "Summarize knowledge gap",
  description: "Summarises a set of unanswered or weakly answered questions into one prioritised gap.",
  usedBy: ["watcher · queue mode"],
  outputShape: '{ summary, priority, rationale }',
  instructions: `Summarize these unanswered or weakly answered knowledge base questions.

Return JSON only:
{
  "summary": "string",
  "priority": 1,
  "rationale": "string"
}`
};

export const DRAFT_MARKDOWN_PROPOSAL: PromptDefinition = {
  id: "draft-markdown-proposal",
  title: "Draft Markdown proposal",
  description:
    "Drafts a single cohesive Markdown article that addresses every listed gap. Used by both queued draft jobs and the API direct path.",
  usedBy: ["watcher · queue mode", "api · direct mode"],
  outputShape: '{ title, targetPath, markdown, rationale }',
  instructions: `Draft a single Markdown knowledge base proposal that addresses every gap listed in gapSummaries.

Rules:
- Return JSON only.
- gapSummaries may contain several related gaps; write ONE cohesive article that covers all of them rather than separate sections that repeat each other.
- Markdown must be reviewable and conservative.
- Use sourceContext when present as raw material for improving the destination knowledge base.
- Cite source file paths, URLs, or agent/internet source names in the rationale.
- Include frontmatter with title and status: draft.

Return JSON:
{
  "title": "string",
  "targetPath": "string",
  "markdown": "string",
  "rationale": "string"
}`
};

export const CRUNCH_KNOWLEDGE_BASE: PromptDefinition = {
  id: "crunch-knowledge-base",
  title: "Crunch knowledge base",
  description:
    "Proposes structural maintenance (consolidate/split/rewrite) over the Markdown knowledge base. Used by both queued crunch jobs and the API direct path.",
  usedBy: ["watcher · queue mode", "api · direct mode"],
  outputShape: '{ summary, operations[], rationale }',
  instructions: `You are tidying a fragmented Markdown knowledge base. Propose structural maintenance only — do not invent new facts.

Goal:
- CONSOLIDATE documents that overlap or are too small and scattered into a single cohesive document.
- SPLIT documents that have grown large and cover several unrelated topics into focused documents.
- Preserve all existing information. Only reorganize, merge, and lightly rewrite headings.

Rules:
- Return JSON only.
- Every operation must list the source paths it reorganizes, the files to write (full new content), and the files to delete.
- Use existing document paths exactly as provided in the input.
- If the knowledge base is already tidy, return an empty operations array.

Return JSON:
{
  "summary": "string",
  "operations": [
    {
      "kind": "consolidate | split | rewrite",
      "title": "string",
      "reason": "string",
      "sources": ["existing/path.md"],
      "writes": [{ "path": "new/path.md", "content": "string" }],
      "deletes": ["existing/path.md"]
    }
  ],
  "rationale": "string"
}`
};

export const GAP_CLUSTERING: PromptDefinition = {
  id: "gap-clustering",
  title: "Cluster related gaps",
  description: "Groups related knowledge-base gaps that a single Markdown article could resolve.",
  usedBy: ["api · direct mode"],
  outputShape: '{ clusters[] }',
  instructions:
    'Group related knowledge-base gaps that a single Markdown article could resolve. ' +
    'Two gaps belong together only when one proposal would naturally answer both. ' +
    'Return JSON only with this shape: {"clusters":[{"title":"string","summaries":["string"],"rationale":"string"}]}. ' +
    'Use the gap summary strings exactly as provided. Every input summary must appear in exactly one cluster. ' +
    'Prefer several small, focused clusters over one broad cluster.'
};

export const GENERIC_JOB: PromptDefinition = {
  id: "generic-job",
  title: "Generic job fallback",
  description:
    "Fallback prompt for job types without a dedicated prompt (e.g. detect_contradiction, suggest_consolidation).",
  usedBy: ["watcher · queue mode"],
  outputShape: "JSON (job-specific)",
  instructions: `Complete this Markdown Magpie AI job. Return JSON only.`
};

export const JOB_RUNNER_SYSTEM: PromptDefinition = {
  id: "job-runner-system",
  title: "Job runner system message",
  description:
    "System message sent alongside every queued job when the watcher uses an OpenAI-compatible agent runner.",
  usedBy: ["watcher · queue runner"],
  outputShape: "n/a (system message)",
  instructions: `You complete Markdown Magpie AI jobs. Return only valid JSON matching the requested schema.`
};

export const promptCatalog: PromptDefinition[] = [
  ANSWER_QUESTION_QUEUE,
  ANSWER_QUESTION_DIRECT,
  SUMMARIZE_GAP,
  DRAFT_MARKDOWN_PROPOSAL,
  CRUNCH_KNOWLEDGE_BASE,
  GAP_CLUSTERING,
  GENERIC_JOB,
  JOB_RUNNER_SYSTEM
];

export function getPrompt(id: string): PromptDefinition | undefined {
  return promptCatalog.find((prompt) => prompt.id === id);
}
```

- [ ] **Step 6: Create `packages/prompts/src/index.ts`**

```ts
export * from "./types.js";
export * from "./catalog.js";
export * from "./build.js";
```

(Note: `./build.js` is created in Task 2. Until then the barrel re-exports a not-yet-created module; create `build.ts` in Task 2 before running a full build. The catalog test in Step 9 imports `./catalog.js` directly, so it does not need `build.ts`.)

- [ ] **Step 7: Add the path alias to `tsconfig.base.json`**

In the `paths` object, add the `@magpie/prompts` entry (keep alphabetical-ish ordering near the others):

```json
    "paths": {
      "@magpie/core": ["packages/core/src/index.ts"],
      "@magpie/git": ["packages/git/src/index.ts"],
      "@magpie/jobs": ["packages/jobs/src/index.ts"],
      "@magpie/markdown": ["packages/markdown/src/index.ts"],
      "@magpie/prompts": ["packages/prompts/src/index.ts"],
      "@magpie/retrieval": ["packages/retrieval/src/index.ts"]
    }
```

- [ ] **Step 8: Update the root `package.json` build script ordering**

Insert `npm run build -w @magpie/prompts` immediately after the core build and before retrieval. The full `build` script becomes:

```
"build": "npm run build -w @magpie/core && npm run build -w @magpie/prompts && npm run build -w @magpie/markdown && npm run build -w @magpie/retrieval && npm run build -w @magpie/git && npm run build -w @magpie/jobs && npm run build -w @magpie/api && npm run build -w @magpie/watcher && npm run build -w @magpie/mcp && npm run build -w @magpie/web",
```

- [ ] **Step 9: Write the failing catalog test `packages/prompts/src/catalog.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptCatalog, getPrompt } from "./catalog.js";

test("catalog has exactly 8 prompts", () => {
  assert.equal(promptCatalog.length, 8);
});

test("all prompt ids are unique", () => {
  const ids = promptCatalog.map((prompt) => prompt.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every prompt has non-empty required fields", () => {
  for (const prompt of promptCatalog) {
    assert.ok(prompt.id.length > 0, `id for ${prompt.title}`);
    assert.ok(prompt.title.length > 0, `title for ${prompt.id}`);
    assert.ok(prompt.description.length > 0, `description for ${prompt.id}`);
    assert.ok(prompt.outputShape.length > 0, `outputShape for ${prompt.id}`);
    assert.ok(prompt.instructions.length > 0, `instructions for ${prompt.id}`);
    assert.ok(Array.isArray(prompt.usedBy) && prompt.usedBy.length > 0, `usedBy for ${prompt.id}`);
  }
});

test("instructions never end with a trailing newline", () => {
  for (const prompt of promptCatalog) {
    assert.ok(!prompt.instructions.endsWith("\n"), `${prompt.id} has trailing newline`);
  }
});

test("getPrompt finds by id and returns undefined for unknown", () => {
  assert.equal(getPrompt("crunch-knowledge-base")?.id, "crunch-knowledge-base");
  assert.equal(getPrompt("does-not-exist"), undefined);
});
```

- [ ] **Step 10: Install the workspace and run the test (expect PASS for catalog, and the package symlink to exist)**

Run:
```bash
npm install
npm test -w @magpie/prompts
```
Expected: catalog tests PASS. (If `build.ts` does not yet exist and the test imports only `./catalog.js`, that is fine; the test file imports `./catalog.js` directly.)

- [ ] **Step 11: Commit**

```bash
git add packages/prompts tsconfig.base.json package.json package-lock.json
git commit -m "feat(prompts): add @magpie/prompts package with prompt catalog"
```

---

### Task 2: Add `buildJobPrompt` queue-mode builder

**Files:**
- Create: `packages/prompts/src/build.ts`
- Create (test): `packages/prompts/src/build.test.ts`

**Interfaces:**
- Consumes: `AiJob`, `AnswerQuestionJobInput`, `SummarizeGapJobInput`, `DraftMarkdownProposalJobInput`, `CrunchKnowledgeBaseJobInput` from `@magpie/core`; the definition consts from `./catalog.js`.
- Produces: `buildJobPrompt(job: AiJob): string` — returns the full queue-mode prompt string (instructions + serialised job data). Byte-identical to the watcher's previous inline prompts.

- [ ] **Step 1: Write the failing test `packages/prompts/src/build.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiJob } from "@magpie/core";
import { buildJobPrompt } from "./build.js";
import {
  ANSWER_QUESTION_QUEUE,
  CRUNCH_KNOWLEDGE_BASE,
  DRAFT_MARKDOWN_PROPOSAL,
  GENERIC_JOB,
  SUMMARIZE_GAP
} from "./catalog.js";

function job(type: AiJob["type"], input: unknown): AiJob {
  return {
    id: "job-1",
    type,
    status: "pending",
    input,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z"
  };
}

test("answer_question embeds question and context after the instructions", () => {
  const input = { question: "What now?", context: [{ heading: "H", content: "C" }] };
  const prompt = buildJobPrompt(job("answer_question", input));
  assert.equal(
    prompt,
    `${ANSWER_QUESTION_QUEUE.instructions}\n\nQuestion:\n${input.question}\n\nContext:\n${JSON.stringify(input.context, null, 2)}`
  );
});

test("summarize_gap appends Input block", () => {
  const input = { questions: ["a", "b"] };
  const prompt = buildJobPrompt(job("summarize_gap", input));
  assert.equal(prompt, `${SUMMARIZE_GAP.instructions}\n\nInput:\n${JSON.stringify(input, null, 2)}`);
});

test("draft_markdown_proposal appends Input block", () => {
  const input = { gapSummaries: ["x"] };
  const prompt = buildJobPrompt(job("draft_markdown_proposal", input));
  assert.equal(prompt, `${DRAFT_MARKDOWN_PROPOSAL.instructions}\n\nInput:\n${JSON.stringify(input, null, 2)}`);
});

test("crunch_knowledge_base appends Input block", () => {
  const input = { documents: [{ path: "a.md", content: "c" }] };
  const prompt = buildJobPrompt(job("crunch_knowledge_base", input));
  assert.equal(prompt, `${CRUNCH_KNOWLEDGE_BASE.instructions}\n\nInput:\n${JSON.stringify(input, null, 2)}`);
});

test("unmapped job types fall back to the generic job prompt with the whole job", () => {
  const detectJob = job("detect_contradiction", { foo: 1 });
  const prompt = buildJobPrompt(detectJob);
  assert.equal(prompt, `${GENERIC_JOB.instructions}\n\nJob:\n${JSON.stringify(detectJob, null, 2)}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @magpie/prompts`
Expected: FAIL — cannot find module `./build.js` / `buildJobPrompt` is not defined.

- [ ] **Step 3: Create `packages/prompts/src/build.ts`**

```ts
import type {
  AiJob,
  AnswerQuestionJobInput,
  CrunchKnowledgeBaseJobInput,
  DraftMarkdownProposalJobInput,
  SummarizeGapJobInput
} from "@magpie/core";
import {
  ANSWER_QUESTION_QUEUE,
  CRUNCH_KNOWLEDGE_BASE,
  DRAFT_MARKDOWN_PROPOSAL,
  GENERIC_JOB,
  SUMMARIZE_GAP
} from "./catalog.js";

export function buildJobPrompt(job: AiJob): string {
  if (job.type === "answer_question") {
    const input = job.input as AnswerQuestionJobInput;
    return `${ANSWER_QUESTION_QUEUE.instructions}\n\nQuestion:\n${input.question}\n\nContext:\n${JSON.stringify(input.context, null, 2)}`;
  }

  if (job.type === "summarize_gap") {
    return `${SUMMARIZE_GAP.instructions}\n\nInput:\n${JSON.stringify(job.input as SummarizeGapJobInput, null, 2)}`;
  }

  if (job.type === "draft_markdown_proposal") {
    return `${DRAFT_MARKDOWN_PROPOSAL.instructions}\n\nInput:\n${JSON.stringify(job.input as DraftMarkdownProposalJobInput, null, 2)}`;
  }

  if (job.type === "crunch_knowledge_base") {
    return `${CRUNCH_KNOWLEDGE_BASE.instructions}\n\nInput:\n${JSON.stringify(job.input as CrunchKnowledgeBaseJobInput, null, 2)}`;
  }

  return `${GENERIC_JOB.instructions}\n\nJob:\n${JSON.stringify(job, null, 2)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @magpie/prompts`
Expected: PASS (all build + catalog tests).

- [ ] **Step 5: Build the package so downstream consumers resolve it via node_modules**

Run: `npm run build -w @magpie/prompts && npm run typecheck -w @magpie/prompts`
Expected: no errors; `packages/prompts/dist/index.js` exists.

- [ ] **Step 6: Commit**

```bash
git add packages/prompts/src/build.ts packages/prompts/src/build.test.ts
git commit -m "feat(prompts): add buildJobPrompt queue-mode builder"
```

---

### Task 3: Wire the watcher to the shared catalog

**Files:**
- Modify: `apps/watcher/package.json` (add dependency)
- Modify: `apps/watcher/src/job-prompts.ts:1-31` (remove inline prompt builders; delegate `buildPrompt` to `buildJobPrompt`)
- Modify: `apps/watcher/src/job-prompts.ts:54-174` (delete `answerQuestionPrompt`, `summarizeGapPrompt`, `draftMarkdownProposalPrompt`, `crunchKnowledgeBasePrompt`, `genericPrompt`)
- Modify: `apps/watcher/src/main.ts:159` (use `JOB_RUNNER_SYSTEM.instructions`)

**Interfaces:**
- Consumes: `buildJobPrompt`, `JOB_RUNNER_SYSTEM` from `@magpie/prompts`.
- Produces: unchanged public surface — `buildPrompt(job)` and `parseJobOutput(job, stdout)` keep the same signatures and behaviour.

- [ ] **Step 1: Add the dependency to `apps/watcher/package.json`**

In `dependencies`, add (keep `@magpie/core` above it):

```json
  "dependencies": {
    "@magpie/core": "file:../../packages/core",
    "@magpie/prompts": "file:../../packages/prompts",
    "tsx": "^4.22.4"
  },
```

Then run `npm install` to link it.

- [ ] **Step 2: Replace the top of `apps/watcher/src/job-prompts.ts`**

Replace the existing import block and `buildPrompt` function (lines 1-31) with:

```ts
import type {
  AiJob,
  AnswerQuestionJobOutput,
  CrunchKnowledgeBaseJobOutput,
  DraftMarkdownProposalJobOutput,
  SummarizeGapJobOutput
} from "@magpie/core";
import { buildJobPrompt } from "@magpie/prompts";

export function buildPrompt(job: AiJob): string {
  return buildJobPrompt(job);
}
```

(The input-type imports `AnswerQuestionJobInput`, `SummarizeGapJobInput`, `DraftMarkdownProposalJobInput`, `CrunchKnowledgeBaseJobInput` are removed — they are only used by the deleted builders. The `*JobOutput` types remain because `parseJobOutput` and the `assert*` validators still use them.)

- [ ] **Step 3: Delete the inline prompt builder functions**

Delete `answerQuestionPrompt` (was lines 54-96), `summarizeGapPrompt` (98-110), `draftMarkdownProposalPrompt` (112-133), `crunchKnowledgeBasePrompt` (135-167), and `genericPrompt` (169-174). Keep `parseJobOutput`, `extractJson`, `assertAnswerQuestionOutput`, `assertSummarizeGapOutput`, `assertDraftMarkdownProposalOutput`, `assertCrunchKnowledgeBaseOutput`, and `isConfidence` exactly as they are.

- [ ] **Step 4: Use the shared system message in `apps/watcher/src/main.ts`**

Add to the imports near the top of the file (after the existing `import { buildPrompt, parseJobOutput } from "./job-prompts.js";` on line 16):

```ts
import { JOB_RUNNER_SYSTEM } from "@magpie/prompts";
```

Then replace the inline string at line 159:

```ts
            content: "You complete Markdown Magpie AI jobs. Return only valid JSON matching the requested schema."
```

with:

```ts
            content: JOB_RUNNER_SYSTEM.instructions
```

- [ ] **Step 5: Typecheck and build the watcher (it has no unit tests)**

Run: `npm run typecheck -w @magpie/watcher && npm run build -w @magpie/watcher`
Expected: no type errors; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/watcher/package.json apps/watcher/src/job-prompts.ts apps/watcher/src/main.ts package-lock.json
git commit -m "refactor(watcher): use @magpie/prompts for job prompts and system message"
```

---

### Task 4: Wire the retrieval package to the shared answer prompt

**Files:**
- Modify: `packages/retrieval/package.json` (add dependency)
- Modify: `packages/retrieval/src/index.ts:1` (add import)
- Modify: `packages/retrieval/src/index.ts:146-151` (use `ANSWER_QUESTION_DIRECT.instructions`)

**Interfaces:**
- Consumes: `ANSWER_QUESTION_DIRECT` from `@magpie/prompts`.
- Produces: `answerQuestion(...)` behaviour unchanged (same system text value).

- [ ] **Step 1: Add the dependency to `packages/retrieval/package.json`**

In `dependencies`:

```json
  "dependencies": {
    "@magpie/core": "file:../core",
    "@magpie/prompts": "file:../prompts"
  },
```

Then run `npm install`.

- [ ] **Step 2: Add the import to `packages/retrieval/src/index.ts`**

After the existing first import line, add:

```ts
import { ANSWER_QUESTION_DIRECT } from "@magpie/prompts";
```

- [ ] **Step 3: Replace the inline system string (lines 146-151)**

Replace:

```ts
    system:
      "Answer using only the provided Markdown knowledge base context. Return only JSON with this shape: " +
      '{"answer":"string","confidence":"high|medium|low","isKnowledgeGap":true|false,"gaps":["string"]}. ' +
      "Set isKnowledgeGap to true and confidence to low when the context does not specifically answer the question. " +
      'List each distinct piece of missing knowledge as its own entry in "gaps" — a question that asks about several ' +
      "unrelated topics should produce one gap per unanswered topic. Use an empty array when the answer is fully supported.",
```

with:

```ts
    system: ANSWER_QUESTION_DIRECT.instructions,
```

- [ ] **Step 4: Run the retrieval tests (must stay green)**

Run: `npm test -w @magpie/retrieval && npm run typecheck -w @magpie/retrieval`
Expected: PASS — existing tests unaffected (the mock provider does not read the system text; the real providers receive the same string as before).

- [ ] **Step 5: Commit**

```bash
git add packages/retrieval/package.json packages/retrieval/src/index.ts package-lock.json
git commit -m "refactor(retrieval): source the direct answer prompt from @magpie/prompts"
```

---

### Task 5: Wire the API direct-mode services to the shared catalog

**Files:**
- Modify: `apps/api/package.json` (add dependency)
- Modify: `apps/api/src/features/crunch/service.ts:102-108` (+ import) — use `CRUNCH_KNOWLEDGE_BASE.instructions`
- Modify: `apps/api/src/features/proposals/service.ts:298-301` (+ import) — use `DRAFT_MARKDOWN_PROPOSAL.instructions`
- Modify: `apps/api/src/features/gaps/service.ts:39-44` (+ import) — use `GAP_CLUSTERING.instructions`

**Interfaces:**
- Consumes: `CRUNCH_KNOWLEDGE_BASE`, `DRAFT_MARKDOWN_PROPOSAL`, `GAP_CLUSTERING` from `@magpie/prompts`.
- Produces: same service signatures. Intentional change: crunch and draft direct prompts now use the richer (watcher) wording.

- [ ] **Step 1: Add the dependency to `apps/api/package.json`**

In `dependencies`, add the `@magpie/prompts` line (after `@magpie/markdown`):

```json
    "@magpie/markdown": "file:../../packages/markdown",
    "@magpie/prompts": "file:../../packages/prompts",
    "@magpie/retrieval": "file:../../packages/retrieval",
```

Then run `npm install`.

- [ ] **Step 2: Update `apps/api/src/features/crunch/service.ts`**

Add an import near the top (alongside the other `@magpie/*` imports):

```ts
import { CRUNCH_KNOWLEDGE_BASE } from "@magpie/prompts";
```

Replace the `system:` block (lines 102-108):

```ts
    system:
      "You tidy a fragmented Markdown knowledge base by proposing structural maintenance only. " +
      "Consolidate overlapping or tiny documents and split large multi-topic documents. Preserve all information. " +
      'Return JSON only with this shape: {"summary":"string","operations":[{"kind":"consolidate|split|rewrite",' +
      '"title":"string","reason":"string","sources":["path"],"writes":[{"path":"string","content":"string"}],' +
      '"deletes":["path"]}],"rationale":"string"}. Use existing document paths exactly. ' +
      "If the knowledge base is already tidy, return an empty operations array.",
```

with:

```ts
    system: CRUNCH_KNOWLEDGE_BASE.instructions,
```

- [ ] **Step 3: Update `apps/api/src/features/proposals/service.ts`**

Add the import:

```ts
import { DRAFT_MARKDOWN_PROPOSAL } from "@magpie/prompts";
```

Replace the `system:` block (lines 298-301):

```ts
    system:
      "Draft a conservative Markdown knowledge base proposal for the provided gap. Return JSON only with this shape: " +
      '{"title":"string","targetPath":"string","markdown":"string","rationale":"string"}. ' +
      "Include frontmatter with title and status: draft in the markdown field.",
```

with:

```ts
    system: DRAFT_MARKDOWN_PROPOSAL.instructions,
```

- [ ] **Step 4: Update `apps/api/src/features/gaps/service.ts`**

Add the import:

```ts
import { GAP_CLUSTERING } from "@magpie/prompts";
```

Replace the `system:` block (lines 39-44):

```ts
    system:
      "Group related knowledge-base gaps that a single Markdown article could resolve. " +
      "Two gaps belong together only when one proposal would naturally answer both. " +
      'Return JSON only with this shape: {"clusters":[{"title":"string","summaries":["string"],"rationale":"string"}]}. ' +
      "Use the gap summary strings exactly as provided. Every input summary must appear in exactly one cluster. " +
      "Prefer several small, focused clusters over one broad cluster.",
```

with:

```ts
    system: GAP_CLUSTERING.instructions,
```

- [ ] **Step 5: Run the API tests (must stay green)**

Run: `npm test -w @magpie/api && npm run typecheck -w @magpie/api`
Expected: PASS — `service.test.ts` files use the mock provider, which short-circuits before the prompt is read, so the wording change does not affect assertions.

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json apps/api/src/features/crunch/service.ts apps/api/src/features/proposals/service.ts apps/api/src/features/gaps/service.ts package-lock.json
git commit -m "refactor(api): source direct-mode prompts from @magpie/prompts"
```

---

### Task 6: Add the `GET /api/prompts` endpoint

**Files:**
- Create: `apps/api/src/features/prompts/routes.ts`
- Modify: `apps/api/src/app.ts` (import + mount)
- Modify (test): `apps/api/src/app.test.ts` (append smoke test)

**Interfaces:**
- Consumes: `promptCatalog` from `@magpie/prompts`; `AppContext` from `../../context.js`.
- Produces: `promptRoutes(ctx: AppContext): Hono` exposing `GET /prompts` → `{ prompts: PromptDefinition[] }`.

- [ ] **Step 1: Write the failing smoke test (append to `apps/api/src/app.test.ts`)**

```ts
test("GET /api/prompts returns the catalog", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/prompts");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { prompts: Array<Record<string, unknown>> };
  assert.equal(body.prompts.length, 8);
  for (const prompt of body.prompts) {
    assert.equal(typeof prompt.id, "string");
    assert.equal(typeof prompt.title, "string");
    assert.equal(typeof prompt.description, "string");
    assert.equal(typeof prompt.outputShape, "string");
    assert.equal(typeof prompt.instructions, "string");
    assert.ok(Array.isArray(prompt.usedBy));
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @magpie/api`
Expected: FAIL — `/api/prompts` returns 404 `not_found`.

- [ ] **Step 3: Create `apps/api/src/features/prompts/routes.ts`**

```ts
import { Hono } from "hono";
import { promptCatalog } from "@magpie/prompts";
import type { AppContext } from "../../context.js";

export function promptRoutes(_ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/prompts", (c) => c.json({ prompts: promptCatalog }));

  return app;
}
```

- [ ] **Step 4: Mount the router in `apps/api/src/app.ts`**

Add the import alongside the other feature-route imports:

```ts
import { promptRoutes } from "./features/prompts/routes.js";
```

Add the mount after the `jobRoutes` line (line 42):

```ts
  api.route("/ai-jobs", jobRoutes(ctx));
  api.route("/", promptRoutes(ctx));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w @magpie/api && npm run typecheck -w @magpie/api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/features/prompts/routes.ts apps/api/src/app.ts apps/api/src/app.test.ts
git commit -m "feat(api): add GET /api/prompts endpoint serving the prompt catalog"
```

---

### Task 7: Add the "Prompts" section to the web console

**Files:**
- Modify: `apps/web/src/app/page.tsx` (type, state, fetch, nav, render, panel, section title/subtitle)
- Modify: `apps/web/src/app/styles.css` (prompt card styles)

**Interfaces:**
- Consumes: `GET /api/prompts` via the existing `apiGet` helper.
- Produces: a new `"prompts"` `ConsoleSection`, a `PromptsPanel` component, and the local `PromptSummary` interface.

(The web app is not an npm dependency of `@magpie/prompts`; declare a local `PromptSummary` interface that matches the serialised shape rather than importing the package.)

- [ ] **Step 1: Add the `PromptSummary` interface and extend `ConsoleSection`**

In `apps/web/src/app/page.tsx`, immediately above the `type ConsoleSection = …` declaration (line 94), add:

```ts
interface PromptSummary {
  id: string;
  title: string;
  description: string;
  usedBy: string[];
  outputShape: string;
  instructions: string;
}
```

Then change the `ConsoleSection` union to include `"prompts"`:

```ts
type ConsoleSection = "ask" | "answered" | "knowledge" | "gaps" | "jobs" | "proposals" | "crunch" | "prompts" | "config" | "dataflow";
```

- [ ] **Step 2: Add the `prompts` state**

After the `const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);` line (line 387), add:

```ts
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
```

- [ ] **Step 3: Fetch the catalog inside `refresh()`**

In the `Promise.all` destructuring (line 481), append `promptsResult` to the array of names, and add the matching `apiGet` call as the last entry in the array (after the `/config` call on line 494):

The destructuring target becomes:
```ts
      const [healthResult, statsResult, repositoriesResult, documentsResult, questionsResult, gapsResult, clustersResult, jobsResult, proposalsResult, crunchRunsResult, crunchSettingsResult, scheduledTasksResult, configResult, promptsResult] = await Promise.all([
```

And add as the final array element (after `apiGet<RuntimeConfig>("/config")`, with a comma added to that line):
```ts
        apiGet<RuntimeConfig>("/config"),
        apiGet<{ prompts: PromptSummary[] }>("/prompts")
      ]);
```

Then, after `setConfig(configResult);` (line 509), add:
```ts
      setPrompts(promptsResult.prompts);
```

- [ ] **Step 4: Add the nav button**

In the sidebar `<nav>`, add a button after the Crunch button (line 872) and before the Data Flow button:

```tsx
          <NavButton active={activeSection === "prompts"} count={prompts.length} glyph="Pr" label="Prompts" onClick={() => openSection("prompts")} />
```

- [ ] **Step 5: Add the section render block**

After the Crunch render block (which ends at line 1117) and before the Data Flow block (line 1119), add:

```tsx
        {activeSection === "prompts" ? (
          <section className="workbench singlePane">
            <PromptsPanel prompts={prompts} />
          </section>
        ) : null}
```

- [ ] **Step 6: Add the `PromptsPanel` component**

Add this component next to the other panel components (e.g. immediately after the `AttentionPanel` function, around line 1158):

```tsx
function PromptsPanel({ prompts }: { prompts: PromptSummary[] }) {
  if (prompts.length === 0) {
    return <p className="promptEmpty">No prompts are registered.</p>;
  }

  return (
    <div className="promptList">
      {prompts.map((prompt) => (
        <article className="promptCard" key={prompt.id}>
          <div className="promptCardHead">
            <h2>{prompt.title}</h2>
            <code>{prompt.id}</code>
          </div>
          <p className="promptDescription">{prompt.description}</p>
          <div className="promptChips">
            {prompt.usedBy.map((usage) => (
              <span className="chip" key={usage}>
                {usage}
              </span>
            ))}
          </div>
          <p className="promptOutput">
            <strong>Output:</strong> {prompt.outputShape}
          </p>
          <pre className="promptInstructions">{prompt.instructions}</pre>
        </article>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Add the section title and subtitle**

In `sectionTitle()`, add before the final `return "Ask and inspect cited answers";` (line 3119):

```ts
  if (section === "prompts") {
    return "Browse AI prompts";
  }
```

In `sectionSubtitle()`, add before its final `return "Ask and inspect cited answers";` (line 3152):

```ts
  if (section === "prompts") {
    return "Read the exact instruction text sent to the AI for each job type, and where each prompt is used.";
  }
```

- [ ] **Step 8: Add styles to `apps/web/src/app/styles.css`**

Append:

```css
.promptList {
  display: grid;
  gap: 16px;
}

.promptCard {
  border: 1px solid #d8e0d0;
  border-radius: 10px;
  padding: 16px;
  background: #ffffff;
  display: grid;
  gap: 10px;
}

.promptCardHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.promptCardHead h2 {
  margin: 0;
  font-size: 1.05rem;
}

.promptDescription {
  margin: 0;
  color: #45513f;
}

.promptChips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.promptOutput {
  margin: 0;
  font-size: 0.9rem;
  color: #45513f;
}

.promptInstructions {
  margin: 0;
  padding: 12px;
  background: #17211d;
  color: #f5f7f2;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.82rem;
  line-height: 1.45;
  overflow-x: auto;
}

.promptEmpty {
  color: #45513f;
}
```

- [ ] **Step 9: Typecheck and build the web app (no unit test runner)**

Run: `npm run typecheck -w @magpie/web && npm run build -w @magpie/web`
Expected: type check passes; Next.js build succeeds.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/app/page.tsx apps/web/src/app/styles.css
git commit -m "feat(web): add read-only Prompts section to the console"
```

---

### Task 8: Full integration verification and documentation

**Files:**
- Modify: `README.md` (document the prompt catalog, endpoint, and console section)

- [ ] **Step 1: Build the whole workspace in dependency order**

Run: `npm run build`
Expected: all packages and apps build with no errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all workspace tests pass (prompts, api, retrieval, plus existing suites).

- [ ] **Step 3: Run the repo-wide type check**

Run: `npm run typecheck`
Expected: no errors across `apps/**` and `packages/**`.

- [ ] **Step 4: Document the feature in `README.md`**

Find the section that describes the AI jobs / architecture (search for "AI job" or "watcher"). Add a short subsection, for example:

```markdown
### AI prompts

All AI/agent prompts live in the `@magpie/prompts` package (`packages/prompts`) as a single
catalog of `PromptDefinition` entries. The watcher (queue mode) wraps an instruction with the
serialised job input via `buildJobPrompt`; the API and retrieval (direct mode) pass the same
instruction text as the chat `system` message. The catalog is served read-only at
`GET /api/prompts` and rendered in the console's **Prompts** section.
```

Match the surrounding heading level and tone of the existing README.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document the shared prompt catalog and Prompts console section"
```

---

## Self-Review

**Spec coverage:**
- Inventory of all 8 prompts → Task 1 catalog. ✓
- Consolidate crunch + draft across queue/direct → Tasks 1, 3, 5 (shared consts; queue via `buildJobPrompt`, direct via `.instructions`). ✓
- Keep two `answer_question` variants → `ANSWER_QUESTION_QUEUE` (Task 3) and `ANSWER_QUESTION_DIRECT` (Task 4). ✓
- `summarize_gap` vs `gap_clustering` kept distinct → separate catalog entries. ✓
- New `@magpie/prompts` package depending only on `@magpie/core`; standard wiring + build order + path alias → Task 1. ✓
- "Used where they are" call-site refactors (watcher buildPrompt + system message, retrieval, api crunch/proposals/gaps) → Tasks 3, 4, 5. ✓
- `GET /api/prompts` read-only endpoint, mounted, smoke-tested → Task 6. ✓
- New console "prompts" section following existing conventions (union, nav, panel, title/subtitle, css) → Task 7. ✓
- Tests: prompts unit tests (unique ids, every job type maps via buildJobPrompt incl. generic fallback, instructions+data composition), API smoke test, existing suites green → Tasks 1, 2, 6, 8. ✓
- Docs updated → Task 8. ✓
- Out of scope (DB editing, unifying answer variants, provider changes) → not present in any task. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands with expected output.

**Type consistency:** `PromptDefinition` fields (`id`, `title`, `description`, `usedBy`, `outputShape`, `instructions`) are used identically in the catalog, the API test, and the web `PromptSummary` mirror. `buildJobPrompt(job: AiJob): string` signature matches its consumer in `job-prompts.ts`. Definition const names (`ANSWER_QUESTION_QUEUE`, `ANSWER_QUESTION_DIRECT`, `SUMMARIZE_GAP`, `DRAFT_MARKDOWN_PROPOSAL`, `CRUNCH_KNOWLEDGE_BASE`, `GAP_CLUSTERING`, `GENERIC_JOB`, `JOB_RUNNER_SYSTEM`) are consistent across catalog, build, watcher, retrieval, and api tasks.
