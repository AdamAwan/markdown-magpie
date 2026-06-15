# Reset Data Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Reset data" button to the Config page that wipes all user-generated state and rebuilds the knowledge bases from `.env`, so each demo starts from a fresh-from-config state.

**Architecture:** Each data store gains a `reset()` method (Postgres + in-memory implementations) so clearing goes through the existing repository abstraction rather than raw SQL in the HTTP handler. `main.ts` gets a reusable `seedConfiguredKnowledge()` helper (refactored out of the existing index handler) and a new `POST /api/admin/reset` endpoint that clears every store, resets the in-memory index and runtime AI config, then re-syncs and re-indexes the configured knowledge sources. The web `ConfigPanel` gets a destructive button with inline Confirm/Cancel that calls the endpoint and refreshes config.

**Tech Stack:** TypeScript, Node.js native `http` server, `pg` (node-postgres, raw SQL), Next.js/React (web), `node:test` + `node:assert/strict` for tests. Monorepo with npm workspaces (`@magpie/api`, `@magpie/core`, `@magpie/web`).

**Reference docs to skim before starting:**
- `docs/superpowers/specs/2026-06-15-reset-data-button-design.md` — the approved design.
- `docs/api.md` — HTTP API reference (you will add an entry).
- `scripts/run-cat-demo.ps1` (line ~195) — shows the boot→index demo flow this reset replicates.

**Conventions:**
- Run all tests from the repo root with `npm test` (runs every workspace). To run just the API workspace: `npm run test -w @magpie/api`.
- `.js` import extensions are used in source even for `.ts` files (ESM + tsx). Follow existing imports exactly.
- Postgres-backed tests gate with node:test's `skip` option: `{ skip: process.env.DATABASE_URL ? false : "DATABASE_URL not set" }`. Logic tests run against the in-memory implementations and need no database.
- Commit after each task.

---

## File Structure

**Modified:**
- `packages/core/src/index.ts` — add `reset()` to the `AiJobQueue` interface.
- `apps/api/src/ai-job-queue.ts` — `InMemoryAiJobQueue.reset()`.
- `apps/api/src/postgres-ai-job-queue.ts` — `PostgresAiJobQueue.reset()`.
- `apps/api/src/question-log-store.ts` — add `reset()` to `QuestionLogStore`, implement on `InMemoryQuestionLogStore`.
- `apps/api/src/postgres-question-log-store.ts` — `PostgresQuestionLogStore.reset()`.
- `apps/api/src/proposal-store.ts` — add `reset()` to `ProposalStore`, implement on `InMemoryProposalStore`.
- `apps/api/src/postgres-proposal-store.ts` — `PostgresProposalStore.reset()`.
- `apps/api/src/knowledge-index.ts` — add `reset()` to `KnowledgePersistence`, implement `InMemoryKnowledgeIndex.reset()`.
- `apps/api/src/postgres-knowledge-store.ts` — `PostgresKnowledgeStore.reset()`.
- `apps/api/src/main.ts` — refactor `handleIndexRepository` to extract `indexRepositoryForPayload`; add `configuredIndexPayloads`, `seedConfiguredKnowledge`, `handleResetData`; register `POST /admin/reset` route.
- `apps/web/src/app/page.tsx` — `ConfigPanel` "Reset data" section.
- `docs/api.md` — document the endpoint.

**New test files:**
- `apps/api/src/reset-stores.test.ts` — in-memory `reset()` behavior for all stores + index.

---

## Task 1: Add `reset()` to the AI job queue

**Files:**
- Modify: `packages/core/src/index.ts:204-211` (the `AiJobQueue` interface)
- Modify: `apps/api/src/ai-job-queue.ts` (`InMemoryAiJobQueue`)
- Modify: `apps/api/src/postgres-ai-job-queue.ts` (`PostgresAiJobQueue`)
- Test: `apps/api/src/reset-stores.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/reset-stores.test.ts` with:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryAiJobQueue } from "./ai-job-queue.js";

test("InMemoryAiJobQueue.reset removes all jobs", async () => {
  const queue = new InMemoryAiJobQueue();
  await queue.enqueue("answer_question", { question: "hi" });
  await queue.enqueue("answer_question", { question: "there" });

  await queue.reset();

  assert.deepEqual(await queue.list(), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @magpie/api -- --test-name-pattern "InMemoryAiJobQueue.reset"`
Expected: FAIL — `queue.reset is not a function`.

- [ ] **Step 3: Add `reset()` to the core interface**

In `packages/core/src/index.ts`, add `reset` to the `AiJobQueue` interface (after `list`):

```typescript
export interface AiJobQueue {
  enqueue<TInput>(type: AiJobType, input: TInput): Promise<AiJob<TInput>>;
  claimNext(workerName: string, acceptedTypes: AiJobType[]): Promise<AiJob | undefined>;
  complete<TOutput>(jobId: string, output: TOutput): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  get(jobId: string): Promise<AiJob | undefined>;
  list(): Promise<AiJob[]>;
  reset(): Promise<void>;
}
```

- [ ] **Step 4: Implement on `InMemoryAiJobQueue`**

In `apps/api/src/ai-job-queue.ts`, add this method to the `InMemoryAiJobQueue` class (e.g. after `list`):

```typescript
  async reset(): Promise<void> {
    this.jobs.clear();
  }
```

- [ ] **Step 5: Implement on `PostgresAiJobQueue`**

In `apps/api/src/postgres-ai-job-queue.ts`, add to the `PostgresAiJobQueue` class:

```typescript
  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM ai_jobs");
  }
```

(Confirm the class exposes `this.pool` like the other Postgres stores; if the field has a different name, match it.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -w @magpie/api -- --test-name-pattern "InMemoryAiJobQueue.reset"`
Expected: PASS.

- [ ] **Step 7: Verify the build**

Run: `npm run typecheck` (root — runs `tsc -p tsconfig.check.json --noEmit`).
Expected: no type errors. In particular, `@magpie/core` consumers compile (the new interface method is implemented everywhere).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/index.ts apps/api/src/ai-job-queue.ts apps/api/src/postgres-ai-job-queue.ts apps/api/src/reset-stores.test.ts
git commit -m "feat: add reset() to AI job queue"
```

---

## Task 2: Add `reset()` to the question log store

Clears `questions` and its dependent `answer_citations` (FK on `answer_citations.question_id`).

**Files:**
- Modify: `apps/api/src/question-log-store.ts:4-13` (interface) and `InMemoryQuestionLogStore`
- Modify: `apps/api/src/postgres-question-log-store.ts` (`PostgresQuestionLogStore`)
- Test: `apps/api/src/reset-stores.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/reset-stores.test.ts`:

```typescript
import { InMemoryQuestionLogStore } from "./question-log-store.js";

test("InMemoryQuestionLogStore.reset removes all questions", async () => {
  const store = new InMemoryQuestionLogStore();
  await store.record({
    question: "How do I adopt a cat?",
    executionMode: "direct",
    chatProvider: "mock",
    retrievedSectionIds: []
  });

  await store.reset();

  assert.deepEqual(await store.list(50), []);
});
```

(Place the `import` line with the other imports at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @magpie/api -- --test-name-pattern "InMemoryQuestionLogStore.reset"`
Expected: FAIL — `store.reset is not a function`.

- [ ] **Step 3: Add `reset()` to the interface**

In `apps/api/src/question-log-store.ts`, add to the `QuestionLogStore` interface (after `listGapCandidates`):

```typescript
  reset(): Promise<void>;
```

- [ ] **Step 4: Implement on `InMemoryQuestionLogStore`**

Add to the `InMemoryQuestionLogStore` class:

```typescript
  async reset(): Promise<void> {
    this.logs.clear();
  }
```

- [ ] **Step 5: Implement on `PostgresQuestionLogStore`**

In `apps/api/src/postgres-question-log-store.ts`, add to the class. Delete citations first to satisfy the foreign key, in one transaction:

```typescript
  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM answer_citations");
      await client.query("DELETE FROM questions");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -w @magpie/api -- --test-name-pattern "InMemoryQuestionLogStore.reset"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/question-log-store.ts apps/api/src/postgres-question-log-store.ts apps/api/src/reset-stores.test.ts
git commit -m "feat: add reset() to question log store"
```

---

## Task 3: Add `reset()` to the proposal store

Clears `proposals`, then `gap_clusters` (proposals reference `gap_clusters.id` via `gap_cluster_id`).

**Files:**
- Modify: `apps/api/src/proposal-store.ts:12-18` (interface) and `InMemoryProposalStore`
- Modify: `apps/api/src/postgres-proposal-store.ts` (`PostgresProposalStore`)
- Test: `apps/api/src/reset-stores.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/reset-stores.test.ts`:

```typescript
import { InMemoryProposalStore } from "./proposal-store.js";

test("InMemoryProposalStore.reset removes all proposals", async () => {
  const store = new InMemoryProposalStore();
  await store.create({
    title: "Add cat care guide",
    targetPath: "cats/care.md",
    markdown: "# Care",
    rationale: "Frequently asked",
    evidence: []
  });

  await store.reset();

  assert.deepEqual(await store.list(50), []);
});
```

(Add the `import` with the others at the top.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @magpie/api -- --test-name-pattern "InMemoryProposalStore.reset"`
Expected: FAIL — `store.reset is not a function`.

- [ ] **Step 3: Add `reset()` to the interface**

In `apps/api/src/proposal-store.ts`, add to the `ProposalStore` interface (after `recordPublication`):

```typescript
  reset(): Promise<void>;
```

- [ ] **Step 4: Implement on `InMemoryProposalStore`**

```typescript
  async reset(): Promise<void> {
    this.proposals.clear();
  }
```

- [ ] **Step 5: Implement on `PostgresProposalStore`**

In `apps/api/src/postgres-proposal-store.ts`, add to the class. Delete proposals first (FK to `gap_clusters`), then gap clusters, in one transaction:

```typescript
  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM proposals");
      await client.query("DELETE FROM gap_clusters");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -w @magpie/api -- --test-name-pattern "InMemoryProposalStore.reset"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/proposal-store.ts apps/api/src/postgres-proposal-store.ts apps/api/src/reset-stores.test.ts
git commit -m "feat: add reset() to proposal store"
```

---

## Task 4: Add `reset()` to the knowledge persistence store

Clears `document_sections`, `documents`, `repositories` (FK order: sections → documents → repositories). Only `PostgresKnowledgeStore` implements `KnowledgePersistence`; there is no in-memory knowledge store (the in-memory backend leaves `knowledgeStore` undefined).

**Files:**
- Modify: `apps/api/src/knowledge-index.ts:26-29` (the `KnowledgePersistence` interface)
- Modify: `apps/api/src/postgres-knowledge-store.ts` (`PostgresKnowledgeStore`)

- [ ] **Step 1: Add `reset()` to the interface**

In `apps/api/src/knowledge-index.ts`, update the interface:

```typescript
export interface KnowledgePersistence {
  saveIndexedRepository(summary: IndexedRepositorySummary, documents: KnowledgeDocument[], sections: DocumentSection[]): Promise<void>;
  loadAll(): Promise<LoadedKnowledge>;
  reset(): Promise<void>;
}
```

- [ ] **Step 2: Implement on `PostgresKnowledgeStore`**

In `apps/api/src/postgres-knowledge-store.ts`, add to the class. Delete in FK order inside one transaction:

```typescript
  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM document_sections");
      await client.query("DELETE FROM documents");
      await client.query("DELETE FROM repositories");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
```

- [ ] **Step 3: Add a DB-gated test**

Append to `apps/api/src/reset-stores.test.ts`:

```typescript
import { describe, it } from "node:test";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";

const databaseUrl = process.env.DATABASE_URL;

describe("PostgresKnowledgeStore.reset", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  it("clears knowledge tables without error", async () => {
    const store = new PostgresKnowledgeStore(databaseUrl as string);
    await store.reset();
    const loaded = await store.loadAll();
    assert.deepEqual(loaded.repositories, []);
    assert.deepEqual(loaded.documents, []);
    assert.deepEqual(loaded.sections, []);
  });
});
```

(Keep `import assert` / `test` at the top; add `describe, it` to the existing `node:test` import or add a second import line — match what the file already has.)

- [ ] **Step 4: Run tests / build**

Run: `npm run test -w @magpie/api` (the Postgres test is skipped without `DATABASE_URL`; the in-memory tests still pass).
Run: `npm run typecheck`.
Expected: PASS / no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/knowledge-index.ts apps/api/src/postgres-knowledge-store.ts apps/api/src/reset-stores.test.ts
git commit -m "feat: add reset() to knowledge persistence store"
```

---

## Task 5: Add `reset()` to the in-memory knowledge index

Clears the in-memory `documents`, `sections`, and `repositories` maps so a Postgres-backed deployment's served index matches the cleared database. Avoids reassigning the `const knowledgeIndex` binding in `main.ts`.

**Files:**
- Modify: `apps/api/src/knowledge-index.ts` (`InMemoryKnowledgeIndex`, fields at lines 64-66)
- Test: `apps/api/src/reset-stores.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/reset-stores.test.ts`:

```typescript
import { InMemoryKnowledgeIndex } from "./knowledge-index.js";

test("InMemoryKnowledgeIndex.reset empties the index stats", async () => {
  const index = new InMemoryKnowledgeIndex();
  await index.indexMarkdownDocuments({
    repositoryId: "cats",
    name: "Cats",
    documents: [{ path: "care.md", content: "# Care\n\nFeed the cat." }]
  });
  assert.ok(index.getStats().sectionCount > 0);

  index.reset();

  assert.deepEqual(index.getStats(), { repositoryCount: 0, documentCount: 0, sectionCount: 0 });
});
```

(Add the `import` with the others.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @magpie/api -- --test-name-pattern "InMemoryKnowledgeIndex.reset"`
Expected: FAIL — `index.reset is not a function`.

- [ ] **Step 3: Implement `reset()`**

In `apps/api/src/knowledge-index.ts`, add a method to the `InMemoryKnowledgeIndex` class (e.g. near `getStats`). It is synchronous (the maps are in memory):

```typescript
  reset(): void {
    this.documents.clear();
    this.sections.clear();
    this.repositories.clear();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @magpie/api -- --test-name-pattern "InMemoryKnowledgeIndex.reset"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/knowledge-index.ts apps/api/src/reset-stores.test.ts
git commit -m "feat: add reset() to in-memory knowledge index"
```

---

## Task 6: Extract re-indexing into a reusable seed helper

Refactor `handleIndexRepository` so the index logic can be reused by the reset endpoint, then add `seedConfiguredKnowledge()` which re-syncs git checkouts and re-indexes every configured knowledge target. No behavior change to the existing `POST /repositories/index` endpoint — this task is a pure refactor plus a new helper, verified by the existing test suite staying green.

**Files:**
- Modify: `apps/api/src/main.ts` (`handleIndexRepository` at lines 574-607; add helpers nearby)

Context — the current `handleIndexRepository` body:
```typescript
async function handleIndexRepository(request, response) {
  const payload = await readJsonBody<{ flowId?; localPath?; repositoryId?; name? }>(request);
  let selection: { localPath; repositoryId?; name? };
  try {
    // ...resolves selection from configured destinations/repositories...
  } catch (error) {
    writeJson(response, 400, ...); return;
  }
  const summary = await knowledgeIndex.indexLocalRepository({ ... });
  writeJson(response, 200, summary);
  void embedSectionsInBackground();
}
```

- [ ] **Step 1: Extract `indexRepositoryForPayload`**

In `apps/api/src/main.ts`, add a new function that contains the resolution + indexing logic (the contents of the current `try` block plus the `indexLocalRepository` call). It throws on resolution failure rather than writing a response:

```typescript
async function indexRepositoryForPayload(payload: {
  flowId?: string;
  localPath?: string;
  repositoryId?: string;
  name?: string;
}): Promise<Awaited<ReturnType<typeof knowledgeIndex.indexLocalRepository>>> {
  let selection: { localPath: string; repositoryId?: string; name?: string };

  const indexableDestinations = configuredKnowledgeDestinations.filter(
    (destination) => destination.kind === "local" || destination.kind === "git"
  );
  if (indexableDestinations.length > 0) {
    const configured = selectDestinationForIndex(payload, indexableDestinations);
    const localPath = await resolveConfiguredRepositoryLocalPath(configured);
    selection = { localPath, repositoryId: configured.id, name: configured.name };
  } else if (configuredKnowledgeDestinations.length > 0) {
    throw new Error("configured_repository_not_indexable");
  } else {
    selection = resolveKnowledgeRepositorySelection(payload, configuredKnowledgeRepositories);
  }

  return knowledgeIndex.indexLocalRepository({
    localPath: selection.localPath,
    repositoryId: selection.repositoryId,
    name: selection.name
  });
}
```

- [ ] **Step 2: Rewrite `handleIndexRepository` to use the helper**

Replace the body of `handleIndexRepository` with:

```typescript
async function handleIndexRepository(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ flowId?: string; localPath?: string; repositoryId?: string; name?: string }>(request);

  let summary: Awaited<ReturnType<typeof indexRepositoryForPayload>>;
  try {
    summary = await indexRepositoryForPayload(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "configured_repository_required";
    writeJson(response, 400, { error: knowledgeRepositoryErrorCode(message), message });
    return;
  }

  writeJson(response, 200, summary);
  void embedSectionsInBackground();
}
```

- [ ] **Step 3: Add `configuredIndexPayloads`**

Add a helper that lists the index targets for a full re-seed, mirroring how the demo indexes each configured flow:

```typescript
function configuredIndexPayloads(): Array<{ flowId?: string; repositoryId?: string }> {
  if (configuredKnowledgeFlows.length > 0) {
    return configuredKnowledgeFlows.map((flow) => ({ flowId: flow.id }));
  }

  const indexableDestinations = configuredKnowledgeDestinations.filter(
    (destination) => destination.kind === "local" || destination.kind === "git"
  );
  if (indexableDestinations.length > 0) {
    return indexableDestinations.map((destination) => ({ repositoryId: destination.id }));
  }

  return configuredKnowledgeRepositories.map((repository) => ({ repositoryId: repository.id }));
}
```

- [ ] **Step 4: Add `seedConfiguredKnowledge`**

```typescript
async function seedConfiguredKnowledge(): Promise<{ indexed: number; failures: Array<{ target: string; message: string }> }> {
  await syncConfiguredGitCheckouts();

  const payloads = configuredIndexPayloads();
  const failures: Array<{ target: string; message: string }> = [];
  let indexed = 0;

  for (const payload of payloads) {
    const target = payload.flowId ?? payload.repositoryId ?? "default";
    try {
      await indexRepositoryForPayload(payload);
      indexed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "index_failed";
      console.warn(`Failed to re-index ${target} during reset: ${message}`);
      failures.push({ target, message });
    }
  }

  void embedSectionsInBackground();
  return { indexed, failures };
}
```

- [ ] **Step 5: Run the existing suite to confirm no regression**

Run: `npm run test -w @magpie/api`
Expected: PASS — the refactor preserves `handleIndexRepository` behavior; existing tests (e.g. `knowledge-repositories.test.ts`, `knowledge-index.test.ts`) still pass.

Run: `npm run typecheck`.
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/main.ts
git commit -m "refactor: extract reusable knowledge re-seed helper"
```

---

## Task 7: Add the `POST /api/admin/reset` endpoint

Clears every store, resets the in-memory index and runtime AI config, then re-seeds knowledge from `.env`. Returns a summary.

**Files:**
- Modify: `apps/api/src/main.ts` — add route (near line 126, with the other `/config` routes) and the `handleResetData` handler.

Context: routing is a sequence of `if (request.method === ... && path === ...)` blocks inside `route` (lines 102-289). `runtimeConfig` is a module-level `let` (line 58). `getRuntimeConfig()` (line 771) builds the response config object. `knowledgeIndex.getStats()` returns `{ repositoryCount, documentCount, sectionCount }`.

- [ ] **Step 1: Register the route**

In the `route` function in `apps/api/src/main.ts`, add after the `POST /config` block (line 129):

```typescript
  if (request.method === "POST" && path === "/admin/reset") {
    await handleResetData(response);
    return;
  }
```

- [ ] **Step 2: Implement `handleResetData`**

Add the handler near the other handlers (e.g. after `handleUpdateRuntimeConfig`):

```typescript
async function handleResetData(response: ServerResponse): Promise<void> {
  // Clear all user-generated state first, so even if re-seeding fails the app
  // is left in a clean (empty) but recoverable state.
  await questionLogs.reset();
  await proposals.reset();
  await aiJobs.reset();
  if (knowledgeStore) {
    await knowledgeStore.reset();
  }
  knowledgeIndex.reset();

  // Reset runtime AI config back to the .env-derived defaults.
  runtimeConfig = createInitialRuntimeConfig();

  // Rebuild the knowledge bases from configuration.
  const seed = await seedConfiguredKnowledge();

  writeJson(response, 200, {
    ok: true,
    reindexed: seed.indexed,
    failures: seed.failures,
    stats: knowledgeIndex.getStats()
  });
}
```

- [ ] **Step 3: Manually verify the route compiles and is reachable**

Run: `npm run typecheck`.
Expected: no type errors (all `reset()` methods exist from Tasks 1-5; `knowledgeStore` is `PostgresKnowledgeStore | undefined`, so the `if (knowledgeStore)` guard is required).

- [ ] **Step 4: Smoke-test against a running API (in-memory backend, no DB needed)**

Start the API in one shell and exercise the endpoint:

```bash
# shell 1
npm run dev -w @magpie/api    # or the documented API start command; check apps/api/package.json scripts
# shell 2
curl -s -X POST http://localhost:4000/api/admin/reset | head
```

Expected: a `200` JSON body like `{"ok":true,"reindexed":<n>,"failures":[],"stats":{...}}`. If `apps/api/package.json` names the dev script differently, use that; the goal is just to confirm the endpoint returns 200.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/main.ts
git commit -m "feat: add POST /admin/reset endpoint"
```

---

## Task 8: Add the "Reset data" button to the Config page

**Files:**
- Modify: `apps/web/src/app/page.tsx` — `ConfigPanel` (lines 1657-1792).

Context: `ConfigPanel` receives `{ apiBaseUrl, config, onConfigChange, onMessage }`. It already uses `useState`, `apiPost<T>(path, body)` (line 2286), and `apiGet<T>(path)` (line 2281). `onMessage(message, tone)` shows a banner with tone `"success" | "danger"`. `onConfigChange(config)` updates the parent's `RuntimeConfig`. The main action button uses `className="button"`.

- [ ] **Step 1: Add reset state to `ConfigPanel`**

Below the existing `useState` declarations (after `const [saving, setSaving] = useState(false);`), add:

```typescript
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
```

- [ ] **Step 2: Add the reset handler**

Add this function inside `ConfigPanel`, near `saveRuntimeConfig`:

```typescript
  async function resetData() {
    setResetting(true);
    setConfirmingReset(false);
    onMessage("");
    try {
      const result = await apiPost<{ reindexed: number; failures: Array<{ target: string; message: string }> }>(
        "/admin/reset",
        {}
      );
      // Re-fetch config so the reset runtime AI config is reflected in the panel.
      const refreshed = await apiGet<RuntimeConfig>("/config");
      onConfigChange(refreshed);
      const failureNote = result.failures.length > 0 ? ` (${result.failures.length} source(s) failed to re-index)` : "";
      onMessage(`Data reset. Re-indexed ${result.reindexed} knowledge source(s)${failureNote}.`, result.failures.length > 0 ? "danger" : "success");
    } catch (error) {
      onMessage(errorMessage(error), "danger");
    } finally {
      setResetting(false);
    }
  }
```

- [ ] **Step 3: Add the UI**

In the returned JSX, add a new block inside `<div className="surfaceBody">`, after the closing `</div>` of `<div className="configStack">` (just before `</div></section>` that ends the panel):

```tsx
        <div className="resetControl">
          <h3>Demo controls</h3>
          <p className="empty">
            Deletes all questions, proposals, gaps and jobs, resets AI config, and re-indexes the
            knowledge bases from configuration.
          </p>
          {confirmingReset ? (
            <div className="resetConfirm">
              <span>This permanently deletes all app data. Continue?</span>
              <button className="button danger" disabled={resetting} onClick={() => void resetData()} type="button">
                {resetting ? "Resetting" : "Confirm reset"}
              </button>
              <button className="button" disabled={resetting} onClick={() => setConfirmingReset(false)} type="button">
                Cancel
              </button>
            </div>
          ) : (
            <button className="button danger" disabled={resetting} onClick={() => setConfirmingReset(true)} type="button">
              Reset data
            </button>
          )}
        </div>
```

- [ ] **Step 4: Confirm the `danger` button style exists (add if missing)**

Check `apps/web/src/app/styles.css` for a `.button.danger` (or `.danger`) rule. The app already uses a `"danger"` message tone, so a danger color likely exists. If `.button.danger` is not styled, add a minimal rule consistent with the existing palette, e.g.:

```css
.button.danger {
  background: #b3261e;
  color: #fff;
}
```

Only add this if no equivalent rule exists. Match the file's existing formatting.

- [ ] **Step 5: Verify the web build**

Run: `npm run build -w @magpie/web` (Next.js build) and `npm run typecheck -w @magpie/web`.
Expected: compiles with no type errors.

- [ ] **Step 6: Manual verification**

With the API and web app running (see project README "Local Development"), open the Config page, click **Reset data**, confirm, and verify the success banner appears and the panel re-renders. Confirm questions/proposals lists are emptied and the knowledge base is present again.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/page.tsx apps/web/src/app/styles.css
git commit -m "feat: add Reset data button to config page"
```

---

## Task 9: Document the endpoint

**Files:**
- Modify: `docs/api.md`

- [ ] **Step 1: Add the endpoint entry**

Open `docs/api.md`, find where admin/config endpoints are documented (near the `POST /config` entry), and add:

```markdown
### POST /admin/reset

Resets the application to its fresh-from-`.env` state. Intended for demos.

**Warning:** This endpoint is unauthenticated and destructive. It is a demo aid and
must not be exposed in a production deployment.

Clears all questions (and their citations), proposals, gap clusters, AI jobs, and
the indexed knowledge (sections, documents, repositories); resets the runtime AI
config (execution mode / provider) to the `.env` defaults; then re-syncs the
configured git checkouts and re-indexes the configured knowledge sources.

Request body: none.

Response `200`:

```json
{
  "ok": true,
  "reindexed": 1,
  "failures": [],
  "stats": { "repositoryCount": 1, "documentCount": 12, "sectionCount": 48 }
}
```

`failures` lists any configured source that could not be re-indexed
(`{ "target": "<flow or repository id>", "message": "<reason>" }`); the clear still
completes fully even if re-indexing a source fails.
```

(Match the heading level and formatting style used by the surrounding entries in `docs/api.md`.)

- [ ] **Step 2: Verify docs reference is consistent**

Skim the new section against the actual response shape from `handleResetData` (Task 7, Step 2). Fields must match: `ok`, `reindexed`, `failures`, `stats`.

- [ ] **Step 3: Commit**

```bash
git add docs/api.md
git commit -m "docs: document POST /admin/reset endpoint"
```

---

## Final verification

- [ ] Run the full suite from the repo root: `npm test`. Expected: all pass (Postgres-gated tests skip without `DATABASE_URL`).
- [ ] Run the type check: `npm run typecheck`. Expected: clean.
- [ ] Manual end-to-end: start API + web, create a question/proposal via the UI, click **Reset data → Confirm**, verify everything clears and the knowledge base re-indexes (a follow-up question still returns cited answers).
- [ ] Confirm `docs/api.md` and the design spec both describe the shipped behavior.
