### Task 4: Wire the retrieval package to the shared answer prompt

**Files:**
- Modify: `packages/retrieval/package.json` (add dependency)
- Modify: `packages/retrieval/src/index.ts:1` (add import)
- Modify: `packages/retrieval/src/index.ts:146-151` (use `ANSWER_QUESTION_DIRECT.instructions`)

**Interfaces:**
- Consumes: `ANSWER_QUESTION_DIRECT` from `@magpie/prompts`.
- Produces: `answerQuestion(...)` behaviour unchanged (same system text value).

- [ ] **Step 1: Add the dependency to `packages/retrieval/package.json`**

In `dependencies`:

```json
  "dependencies": {
    "@magpie/core": "file:../core",
    "@magpie/prompts": "file:../prompts"
  },
```

Then run `npm install`.

- [ ] **Step 2: Add the import to `packages/retrieval/src/index.ts`**

After the existing first import line, add:

```ts
import { ANSWER_QUESTION_DIRECT } from "@magpie/prompts";
```

- [ ] **Step 3: Replace the inline system string (lines 146-151)**

Replace:

```ts
    system:
      "Answer using only the provided Markdown knowledge base context. Return only JSON with this shape: " +
      '{"answer":"string","confidence":"high|medium|low","isKnowledgeGap":true|false,"gaps":["string"]}. ' +
      "Set isKnowledgeGap to true and confidence to low when the context does not specifically answer the question. " +
      'List each distinct piece of missing knowledge as its own entry in "gaps" — a question that asks about several ' +
      "unrelated topics should produce one gap per unanswered topic. Use an empty array when the answer is fully supported.",
```

with:

```ts
    system: ANSWER_QUESTION_DIRECT.instructions,
```

- [ ] **Step 4: Run the retrieval tests (must stay green)**

Run: `npm test -w @magpie/retrieval && npm run typecheck`
Expected: tests PASS and root type-check passes — existing tests unaffected (the mock provider does not read the system text; the real providers receive the same string as before). (Do NOT use `npm run typecheck -w @magpie/retrieval` — pre-existing TS6059; see Global Constraints.)

- [ ] **Step 5: Commit**

```bash
git add packages/retrieval/package.json packages/retrieval/src/index.ts package-lock.json
git commit -m "refactor(retrieval): source the direct answer prompt from @magpie/prompts"
```

---

