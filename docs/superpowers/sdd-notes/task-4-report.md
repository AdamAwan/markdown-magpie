# Task 4 Report: Wire @magpie/retrieval to use shared answer prompt

## Summary
Successfully wired the `@magpie/retrieval` package to use the shared answer prompt from `@magpie/prompts`. The inline system prompt string (6 lines, 457 characters) was replaced with a reference to `ANSWER_QUESTION_DIRECT.instructions` from the prompts package.

## Changes Made

### 1. packages/retrieval/package.json
- Added `@magpie/prompts` to dependencies section as a file-based reference
- Ran `npm install` from repo root to resolve dependencies

### 2. packages/retrieval/src/index.ts
- Line 2: Added import statement: `import { ANSWER_QUESTION_DIRECT } from "@magpie/prompts";`
- Lines 146-151: Replaced 6-line concatenated system prompt string with single line: `system: ANSWER_QUESTION_DIRECT.instructions,`

## Verification Results

### Tests (npm test -w @magpie/retrieval)
```
TAP version 13
# tests 18
# suites 5
# pass 18
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
All 18 tests passed successfully across 5 test suites.

### Typecheck (npm run typecheck)
```
> markdown-magpie@0.1.0 typecheck
> tsc -p tsconfig.check.json --noEmit
```
Root typecheck passed with no errors (exit code 0).

## Files Modified
1. `/home/adam/Code/markdown-magpie/packages/retrieval/package.json` - Added dependency
2. `/home/adam/Code/markdown-magpie/packages/retrieval/src/index.ts` - Added import and replaced inline string
3. `/home/adam/Code/markdown-magpie/package-lock.json` - Updated by npm install

## Self-Review Checklist
- [x] Old inline string completely removed - no leftover fragments or duplicate text
- [x] Import path is correct and uses @magpie/prompts alias
- [x] Replacement is exactly `system: ANSWER_QUESTION_DIRECT.instructions,`
- [x] No type casting through `unknown` introduced
- [x] Behaviour is preserved - same prompt text via new reference path
- [x] All tests pass (18/18)
- [x] Root typecheck passes (exit 0)
- [x] Commit created with specified message

## Concerns
None. The change is straightforward: replacing an inline hardcoded string with a reference to the centralized prompt constant. The mock test provider doesn't inspect the system text, and the real providers receive the identical string value as before, so behaviour is fully preserved.

## Commit
```
commit bef7bbd
Author: Adam Awan <adam.awan121@gmail.com>
Date: [auto-generated timestamp]

    refactor(retrieval): source the direct answer prompt from @magpie/prompts
    
    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```
