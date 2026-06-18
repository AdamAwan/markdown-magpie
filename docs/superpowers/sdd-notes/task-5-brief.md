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

Run: `npm test -w @magpie/api && npm run typecheck`  (root type-check, NOT `-w @magpie/api` — pre-existing TS6059; see Global Constraints)
Expected: PASS — `service.test.ts` files use the mock provider, which short-circuits before the prompt is read, so the wording change does not affect assertions.

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json apps/api/src/features/crunch/service.ts apps/api/src/features/proposals/service.ts apps/api/src/features/gaps/service.ts package-lock.json
git commit -m "refactor(api): source direct-mode prompts from @magpie/prompts"
```

---

