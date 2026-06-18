# Task 2 Report: Add `buildJobPrompt` queue-mode builder

## Summary

Completed Task 2 by implementing `buildJobPrompt(job: AiJob): string` in the `@magpie/prompts` package. The function produces the full queue-mode prompt string (instructions + serialised job data) for different job types, with fallback to generic job handling for unmapped types.

## What was built

1. **File: `packages/prompts/src/build.test.ts`** - 5 unit tests covering:
   - `answer_question` jobs with Question + Context blocks
   - `summarize_gap` jobs with Input block
   - `draft_markdown_proposal` jobs with Input block
   - `crunch_knowledge_base` jobs with Input block
   - Unmapped job types falling back to generic handler

2. **File: `packages/prompts/src/build.ts`** - Implementation of `buildJobPrompt()`:
   - Type-safe handling of 4 specific job types
   - Type-casting where necessary (AiJob input is `unknown`)
   - Generic fallback that includes the entire job object
   - Output format matches watcher's previous inline prompts (no casting through unknown)

3. **File: `packages/prompts/src/index.ts`** - Updated barrel export:
   - Added `export * from "./build.js";` to expose buildJobPrompt to downstream consumers

## TDD Evidence

### RED phase
```bash
npm test -w @magpie/prompts
```
**Result:** FAIL with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/adam/Code/markdown-magpie/packages/prompts/src/build.js'`

### GREEN phase
```bash
npm test -w @magpie/prompts
```
**Result:** PASS - all 10 tests (5 build.test.ts + 5 catalog.test.ts)
```
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### Build
```bash
npm run build -w @magpie/prompts
```
**Result:** SUCCESS - `packages/prompts/dist/` contains compiled JS/declaration files with working exports

```bash
npm run typecheck -w @magpie/prompts
```
**Result:** FAIL with TS6059 (pre-existing monorepo config issue - rootDir validation with path mappings). This issue exists on all packages that depend on @magpie/core (e.g., @magpie/git also fails). The build task uses `tsconfig.build.json` which overrides paths and successfully compiles.

## Files Changed

- **Created:** `packages/prompts/src/build.ts` (34 lines)
- **Created:** `packages/prompts/src/build.test.ts` (68 lines)
- **Modified:** `packages/prompts/src/index.ts` (+1 export line)

## Commit

```
0533881 feat(prompts): add buildJobPrompt queue-mode builder
```

## Self-Review

✅ **Completeness:**
- All 5 test cases from brief implemented and passing
- buildJobPrompt function signature matches brief exactly
- Index exports added as required

✅ **Quality:**
- Strict TypeScript mode compliant
- No casting through `unknown` (used `as` with specific types)
- Code matches brief specification verbatim
- Tests verify exact output format (with proper `\n\n` separators)

✅ **Testing:**
- All 10 tests pass (5 new + 5 existing catalog tests)
- Test coverage includes all job type branches and fallback

⚠️ **Concerns:**
- The `typecheck` npm script fails due to a pre-existing monorepo TypeScript configuration issue (TS6059: paths in tsconfig cause rootDir validation to fail when importing from @magpie/core). This affects all dependent packages (git, jobs, markdown, retrieval). The build task works correctly because `tsconfig.build.json` clears paths. This is NOT introduced by this task and does not affect functionality - the dist/ artifacts are valid and correctly exported.

## Verification

- ✅ Tests run clean: 10/10 passing
- ✅ Build succeeds: dist/ folder populated with valid JS/declaration files
- ✅ Index exports buildJobPrompt correctly
- ✅ Implementation matches brief specification exactly
- ✅ Commit created with correct message
