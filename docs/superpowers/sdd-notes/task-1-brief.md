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

