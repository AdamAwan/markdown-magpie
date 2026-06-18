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

Run: `npm test -w @magpie/api && npm run typecheck`  (root type-check, NOT `-w @magpie/api` — pre-existing TS6059; see Global Constraints)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/features/prompts/routes.ts apps/api/src/app.ts apps/api/src/app.test.ts
git commit -m "feat(api): add GET /api/prompts endpoint serving the prompt catalog"
```

---

