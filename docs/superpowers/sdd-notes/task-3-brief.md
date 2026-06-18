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

Run: `npm run build -w @magpie/watcher && npm run typecheck`
Expected: build succeeds; root type-check passes. (Do NOT use `npm run typecheck -w @magpie/watcher` — it fails with the pre-existing TS6059; see Global Constraints.)

- [ ] **Step 6: Commit**

```bash
git add apps/watcher/package.json apps/watcher/src/job-prompts.ts apps/watcher/src/main.ts package-lock.json
git commit -m "refactor(watcher): use @magpie/prompts for job prompts and system message"
```

---

