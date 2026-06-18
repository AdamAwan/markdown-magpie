# Task 5 Report: Wire API direct-mode services to @magpie/prompts

## Summary
Successfully migrated three API service files (crunch, proposals, gaps) to source their system prompts from the shared `@magpie/prompts` catalog instead of inline strings. All changes completed, tests passing, and root typecheck successful.

## Changes Made

### 1. Dependency Addition
- **File**: `apps/api/package.json`
- **Change**: Added `"@magpie/prompts": "file:../../packages/prompts"` to dependencies (between `@magpie/markdown` and `@magpie/retrieval`)
- **Verification**: `npm install` completed successfully, 53 packages added

### 2. Crunch Service (`apps/api/src/features/crunch/service.ts`)
- **Import added** (line 10): `import { CRUNCH_KNOWLEDGE_BASE } from "@magpie/prompts";`
- **Prompt replacement** (lines 102-103): Replaced 7-line concatenated `system:` block (old lines 102-108) with single line:
  ```ts
  system: CRUNCH_KNOWLEDGE_BASE.instructions,
  ```
- **Intentional change**: The new prompt uses the richer (watcher) wording from the catalog instead of the old API inline string
- **Lines modified**: 102-108 → 102-103

### 3. Proposals Service (`apps/api/src/features/proposals/service.ts`)
- **Import added** (line 9): `import { DRAFT_MARKDOWN_PROPOSAL } from "@magpie/prompts";`
- **Prompt replacement** (lines 298-299): Replaced 4-line concatenated `system:` block (old lines 298-301) with single line:
  ```ts
  system: DRAFT_MARKDOWN_PROPOSAL.instructions,
  ```
- **Intentional change**: The new prompt uses the richer (watcher) wording from the catalog instead of the old API inline string
- **Lines modified**: 298-301 → 298-299

### 4. Gaps Service (`apps/api/src/features/gaps/service.ts`)
- **Import added** (line 2): `import { GAP_CLUSTERING } from "@magpie/prompts";`
- **Prompt replacement** (lines 39-40): Replaced 6-line concatenated `system:` block (old lines 39-44) with single line:
  ```ts
  system: GAP_CLUSTERING.instructions,
  ```
- **No change in wording**: The `GAP_CLUSTERING.instructions` is character-identical to the old inline string (as documented in task brief)
- **Lines modified**: 39-44 → 39-40

## Verification

### Test Results
```
npm test -w @magpie/api
✓ All 85 tests PASSED (23 test suites)
  - Crunch tests: ok (buildMockCrunchPlan, service tests)
  - Proposal tests: ok (all mock/service tests)
  - Gap tests: ok (clustering tests all passing)
  - Unaffected tests: ok (knowledge index, repository config, etc.)
```

### Type Checking
```
npm run typecheck
✓ Root typecheck PASSED (exit 0)
  - No TS6059 errors
  - All service files properly imported
  - No type mismatches with @magpie/prompts exports
```

### Self-Review Checklist
- ✓ All three old inline `system:` strings fully removed (no leftover fragments)
- ✓ All three imports correctly added to the top of each service file
- ✓ Only the `system:` field changed in each service; all other logic untouched
- ✓ No casting through `unknown` added
- ✓ All tests still passing (mock provider short-circuits before prompt read)
- ✓ Dependency correctly added between @magpie/markdown and @magpie/retrieval

## Files Changed
1. `/home/adam/Code/markdown-magpie/apps/api/package.json`
2. `/home/adam/Code/markdown-magpie/apps/api/src/features/crunch/service.ts`
3. `/home/adam/Code/markdown-magpie/apps/api/src/features/proposals/service.ts`
4. `/home/adam/Code/markdown-magpie/apps/api/src/features/gaps/service.ts`
5. `/home/adam/Code/markdown-magpie/package-lock.json` (updated by npm install)

## Commit
- **SHA**: `10b0219`
- **Message**: `refactor(api): source direct-mode prompts from @magpie/prompts`

## Concerns
None. The refactoring is complete, tests pass, and the intentional prompt wording changes (for crunch and proposals) use the richer wording from the shared catalog as documented.
