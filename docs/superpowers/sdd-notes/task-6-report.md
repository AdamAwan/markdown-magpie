# Task 6 Report: Add GET /api/prompts Endpoint

## What Was Built

Implemented a read-only `GET /api/prompts` endpoint that serves the complete prompt catalog from `@magpie/prompts`. The implementation follows TDD methodology and existing API router conventions.

**Files Created:**
- `/home/adam/Code/markdown-magpie/apps/api/src/features/prompts/routes.ts` — New Hono feature router

**Files Modified:**
- `/home/adam/Code/markdown-magpie/apps/api/src/app.ts` — Added import and mount
- `/home/adam/Code/markdown-magpie/apps/api/src/app.test.ts` — Added smoke test

## TDD Evidence

### RED Phase (Test Fails)
Appended failing smoke test to `app.test.ts` (Step 1) and ran `npm test -w @magpie/api`:

```
# Subtest: GET /api/prompts returns the catalog
not ok 8 - GET /api/prompts returns the catalog
  ...
  error: |-
    Expected values to be strictly equal:

    404 !== 200

    code: 'ERR_ASSERTION'
```

**Test Status:** 85 pass, 1 fail. Route returned 404 as expected (not_found).

### GREEN Phase (Tests Pass)
Created `apps/api/src/features/prompts/routes.ts` (Step 3), mounted in `app.ts` (Step 4), and ran `npm test -w @magpie/api`:

```
# Subtest: GET /api/prompts returns the catalog
ok 8 - GET /api/prompts returns the catalog
  ---
  duration_ms: 1.731552
  type: 'test'
```

**Test Status:** 86 pass, 0 fail. ✓

### Type-Check Verification
Ran `npm run typecheck` (root, not workspace) per constraints:

```
> markdown-magpie@0.1.0 typecheck
> tsc -p tsconfig.check.json --noEmit
```

Exit code: 0. ✓

## Implementation Details

### Feature Router (`features/prompts/routes.ts`)
```typescript
import { Hono } from "hono";
import { promptCatalog } from "@magpie/prompts";
import type { AppContext } from "../../context.js";

export function promptRoutes(_ctx: AppContext): Hono {
  const app = new Hono();
  app.get("/prompts", (c) => c.json({ prompts: promptCatalog }));
  return app;
}
```

- Follows existing router pattern (e.g., `jobRoutes`, `askRoutes`)
- Uses `@magpie/prompts` alias for catalog import (NodeNext convention)
- Underscore-prefixed unused `_ctx` parameter follows existing conventions
- Pure data passthrough—no transformation or filtering

### App Mount (`app.ts`)
```typescript
api.route("/", promptRoutes(ctx));
```

Mounted after `jobRoutes` per brief instruction, so full route path is `/api/prompts`.

### Smoke Test (`app.test.ts`)
Validates:
- HTTP 200 status
- Response shape: `{ prompts: [...] }`
- Catalog length: 8 prompts
- Each prompt has required fields: `id`, `title`, `description`, `outputShape`, `instructions`, `usedBy` (array)

## Self-Review

✓ **Completeness:** All three files created/modified per brief
✓ **Follows Router Convention:** Function signature, Hono patterns, import style match existing features
✓ **No `unknown` Casts:** None used
✓ **Tests Pristine:** All 86 tests pass, no flakes, no warnings
✓ **TypeScript:** Root typecheck clean (0 errors)
✓ **Dependencies:** No npm install needed; `@magpie/prompts` already in dependencies
✓ **Commit Message:** Matches brief verbatim
✓ **TDD Evidence:** Clear RED (404) → GREEN (200) progression

## Concerns

None. Implementation is straightforward, tests verify catalog structure, and the endpoint is production-ready.

## Commit

```
a7bed93 feat(api): add GET /api/prompts endpoint serving the prompt catalog
```
