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

