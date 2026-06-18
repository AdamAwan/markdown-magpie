# Task 3 Report: Wire watcher to @magpie/prompts catalog

## Changes Made

### `apps/watcher/package.json`
Added `"@magpie/prompts": "file:../../packages/prompts"` to `dependencies` (between `@magpie/core` and `tsx`).

### `apps/watcher/src/job-prompts.ts`
- **Removed** the four `*JobInput` imports (`AnswerQuestionJobInput`, `CrunchKnowledgeBaseJobInput`, `DraftMarkdownProposalJobInput`, `SummarizeGapJobInput`) from the `@magpie/core` import block — they were only used by the deleted builders.
- **Added** `import { buildJobPrompt } from "@magpie/prompts";`
- **Replaced** the 19-line `buildPrompt` dispatch function with a 3-line delegation to `buildJobPrompt(job)`.
- **Deleted** the five inline prompt builder functions: `answerQuestionPrompt`, `summarizeGapPrompt`, `draftMarkdownProposalPrompt`, `crunchKnowledgeBasePrompt`, `genericPrompt` (lines 54–174 of the original).

### `apps/watcher/src/main.ts`
- Added `import { JOB_RUNNER_SYSTEM } from "@magpie/prompts";` after the existing `./job-prompts.js` import.
- Replaced the inline string `"You complete Markdown Magpie AI jobs. Return only valid JSON matching the requested schema."` with `JOB_RUNNER_SYSTEM.instructions`.

## Verification Commands and Output

```
$ npm install
added 53 packages, and audited 240 packages in 563ms
found 0 vulnerabilities

$ npm run build -w @magpie/watcher && npm run typecheck
> @magpie/watcher@0.1.0 build
> tsc -p tsconfig.build.json

> markdown-magpie@0.1.0 typecheck
> tsc -p tsconfig.check.json --noEmit
```

Both commands exited 0 with no errors or warnings.

## Files Changed

- `apps/watcher/package.json`
- `apps/watcher/src/job-prompts.ts`
- `apps/watcher/src/main.ts`
- `package-lock.json`

## Self-Review

- No orphaned imports remain in `job-prompts.ts`: all four `*JobInput` types removed, all four `*JobOutput` types retained.
- `AiJob` import retained (used by `buildPrompt` signature and `parseJobOutput`).
- `parseJobOutput`, `extractJson`, `assertAnswerQuestionOutput`, `assertSummarizeGapOutput`, `assertDraftMarkdownProposalOutput`, `assertCrunchKnowledgeBaseOutput`, and `isConfidence` are byte-for-byte unchanged.
- Public surface (`buildPrompt(job)` and `parseJobOutput(job, stdout)`) signatures and behaviour preserved.

## Concerns

None. The `JOB_RUNNER_SYSTEM.instructions` string in the catalog is identical to the inline string it replaced, confirmed by reading `packages/prompts/src/catalog.ts`.

## Commit

`676852a` — refactor(watcher): use @magpie/prompts for job prompts and system message
