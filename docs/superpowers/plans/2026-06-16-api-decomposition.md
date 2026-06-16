# API Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break the 2,892-line `apps/api/src/main.ts` god module into a composition root (`AppContext`), a feature-organised service layer, a `platform/` kernel, and a Hono + Zod HTTP edge — without changing API behaviour.

**Architecture:** Feature-first vertical slices (`features/<domain>/{routes,schema,service}.ts`) over a shared `platform/` kernel. A single `AppContext`, built once by a composition root, is injected everywhere, retiring all module-level mutable state. Hono replaces the hand-rolled `node:http` router; Zod replaces hand-rolled type guards. Extract logic first while still on `node:http`, then swap the HTTP edge last so the riskiest change sits on already-extracted, unchanged code.

**Tech Stack:** TypeScript (NodeNext, strict), Node 22, Hono + `@hono/node-server`, Zod + `@hono/zod-validator`, `pg`, `node:test` + `tsx`.

**Reference spec:** `docs/superpowers/specs/2026-06-16-api-decomposition-design.md`

**Working branch:** `refactor/api-decomposition` (already created).

---

## Conventions for this plan

- **Verification per step:** after each extraction commit, run `npm run -w @magpie/api typecheck && npm run build && npm run test`. "Green" below means all three pass. Manual flow checks are listed where a user-facing path changed.
- **Moves vs new code:** when a step says *move* a function, relocate the existing body **verbatim** from `apps/api/src/main.ts`, changing only its signature to accept `ctx: AppContext` (or a narrower slice) instead of reading module globals, and updating the call sites. New files/classes are shown in full.
- **Always green:** the app must build and serve at the end of every task. Phases 0–3 keep `node:http` running until Task 12 swaps it.
- **Commits:** every task ends with a commit on `refactor/api-decomposition`.

---

## File map (end state)

```
apps/api/src/
  main.ts                 # entrypoint
  app.ts                  # Hono app (Task 12)
  context.ts              # AppContext + createAppContext (Task 6)
  config-holder.ts        # RuntimeConfigHolder (Task 4)
  http/errors.ts          # HttpError + onError (Task 11)
  features/
    ask/{routes,schema,service}.ts          (Task 7, 12)
    knowledge/{routes,schema,service}.ts    (Task 7, 12)
    questions/{routes,schema,service}.ts    (Task 8, 12)
    gaps/{routes,schema,service}.ts         (Task 8, 12)
    proposals/{routes,schema,service}.ts    (Task 9, 12)
    crunch/{routes,schema,service}.ts       (Task 10, 12)
    jobs/{routes,schema,service}.ts         (Task 10, 12)
    config/{routes,schema,service}.ts       (Task 9, 12)
  scheduling/{crunch-scheduler,task-scheduler,task-registry}.ts  (Task 11)
  platform/
    paths.ts                (Task 2)
    stores.ts               (Task 3)
    providers.ts            (Task 3)
    background-embedder.ts  (Task 5)
    repositories.ts         (Task 5)
    source-context.ts       (Task 5)
  stores/                   # existing *-store.ts + postgres-*.ts + knowledge-index.ts (Task 1)
```

---

## Phase 0 — Scaffold

### Task 1: Install deps and relocate stores

**Files:**
- Modify: `apps/api/package.json`
- Move (git mv): all `apps/api/src/*-store.ts`, `apps/api/src/postgres-*.ts`, `apps/api/src/ai-job-queue.ts`, `apps/api/src/knowledge-index.ts`, `apps/api/src/embed-sections.ts`, `apps/api/src/gap-clustering.ts`, `apps/api/src/knowledge-repositories.ts` and their `*.test.ts` → `apps/api/src/stores/`

- [ ] **Step 1: Add dependencies**

Run:
```bash
npm install -w @magpie/api hono @hono/node-server @hono/zod-validator zod
```
Expected: `package.json` gains `hono`, `@hono/node-server`, `@hono/zod-validator`, `zod` under dependencies; install succeeds.

- [ ] **Step 2: Move store/index files into `stores/`**

Run:
```bash
cd apps/api/src
mkdir -p stores
git mv ai-job-queue.ts postgres-ai-job-queue.ts ai-job-queue.test.ts \
       proposal-store.ts postgres-proposal-store.ts proposal-store.test.ts proposal-path.test.ts \
       question-log-store.ts postgres-question-log-store.ts question-log-store.test.ts \
       crunch-store.ts postgres-crunch-store.ts crunch.test.ts \
       scheduled-task-store.ts postgres-scheduled-task-store.ts scheduled-task-store.test.ts \
       postgres-knowledge-store.ts postgres-knowledge-store.test.ts reset-stores.test.ts \
       knowledge-index.ts knowledge-index.test.ts embed-sections.ts embed-sections.test.ts \
       gap-clustering.ts gap-clustering.test.ts knowledge-repositories.ts knowledge-repositories.test.ts \
       embed-sections.ts stores/
cd -
```
Expected: files now under `apps/api/src/stores/`. (If a name above does not exist, skip it — the canonical list is whatever matches `*-store.ts`, `postgres-*.ts`, `ai-job-queue*.ts`, `knowledge-*.ts`, `gap-clustering*.ts`, `embed-sections*.ts`.)

- [ ] **Step 3: Fix imports in `main.ts`**

In `apps/api/src/main.ts`, update the relative imports for every moved module from `"./X.js"` to `"./stores/X.js"` (the `./ai-job-queue.js`, `./embed-sections.js`, `./gap-clustering.js`, `./knowledge-index.js`, `./knowledge-repositories.js`, `./crunch-store.js`, `./postgres-*.js`, `./proposal-store.js`, `./question-log-store.js`, `./scheduled-task-store.js` lines at the top of the file).

Also fix cross-imports between the moved files (e.g. a `postgres-*.ts` importing its sibling interface) — these stay relative (`./proposal-store.js`) and need no change since they moved together.

- [ ] **Step 4: Verify green**

Run: `npm run -w @magpie/api typecheck && npm run build && npm run -w @magpie/api test`
Expected: PASS (no behaviour change; only file locations and import paths moved).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(api): add hono/zod deps and relocate stores into stores/"
```

---

### Task 2: Extract pure path/util helpers to `platform/paths.ts`

**Files:**
- Create: `apps/api/src/platform/paths.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: Create `platform/paths.ts`**

Move these functions **verbatim** from `main.ts` into the new file and `export` each: `normalizeRelativePath`, `toPosixPath`, `slugify`, `normalizeUploadPath`, `parseLimit`, `apiLink`. They are pure (no globals).

```ts
// apps/api/src/platform/paths.ts
export function parseLimit(value: string | null, defaultLimit: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return defaultLimit;
  }
  return Math.max(1, Math.min(parsed, 200));
}

export function normalizeUploadPath(value: string | undefined): string {
  const path = value?.trim().replace(/\\/g, "/").replace(/^\/+/, "") ?? "";
  if (!path || path.includes("..")) {
    return "";
  }
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

export function normalizeRelativePath(value: string | undefined): string {
  return value?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") ?? "";
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "docs-update"
  );
}

export function apiLink(path: string): string {
  return `/api${path}`;
}
```

- [ ] **Step 2: Delete the moved functions from `main.ts` and import them**

Remove the original definitions from `main.ts`; add `import { apiLink, normalizeRelativePath, normalizeUploadPath, parseLimit, slugify, toPosixPath } from "./platform/paths.js";`

- [ ] **Step 3: Verify green**

Run: `npm run -w @magpie/api typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(api): extract path/util helpers to platform/paths"
```

---

### Task 3: Extract store & provider factories to `platform/`

**Files:**
- Create: `apps/api/src/platform/stores.ts`, `apps/api/src/platform/providers.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: Create `platform/stores.ts`**

Move **verbatim** and export: `storageBackend`, `storeBackend`, `requireDatabaseUrl`, `parseClaimTimeoutMs`, `createAiJobQueue`, `createQuestionLogStore`, `createProposalStore`, `createCrunchStore`, `createScheduledTaskStore`. Update their internal imports to `"../stores/X.js"`. `createAiJobQueue`/`parseClaimTimeoutMs` reference `aiJobClaimTimeoutMs` and `DEFAULT_AI_JOB_CLAIM_TIMEOUT_MS`; change `createAiJobQueue` to take `claimTimeoutMs: number` as a parameter (the caller passes it) rather than reading a module const.

- [ ] **Step 2: Create `platform/providers.ts`**

Move **verbatim** and export: `embeddingBaseUrl`, `embeddingApiKey`, `embeddingProviderName`, `createConfiguredEmbeddingProvider`, `createConfiguredChatProvider`, `retrievalMode`, `getConfiguredAiProviders`. Keep the `AiProviderName` type here and export it (`export type AiProviderName = ChatProviderName | "codex" | "claude";`). Note `retrievalMode` calls `storeBackend` — import it from `./stores.js`.

- [ ] **Step 3: Rewire `main.ts`**

Delete the moved definitions. Import from the two new modules. `aiJobClaimTimeoutMs` stays computed in `main.ts` for now (`const aiJobClaimTimeoutMs = parseClaimTimeoutMs(process.env.AI_JOB_CLAIM_TIMEOUT_MS)`), passed into `createAiJobQueue(aiJobClaimTimeoutMs)`.

- [ ] **Step 4: Verify green**

Run: `npm run -w @magpie/api typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(api): extract store and provider factories to platform/"
```

---

### Task 4: Introduce `RuntimeConfigHolder`

**Files:**
- Create: `apps/api/src/config-holder.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: Create `config-holder.ts`**

```ts
// apps/api/src/config-holder.ts
import type { AiExecutionMode } from "@magpie/core";
import { getConfiguredAiProviders, type AiProviderName } from "./platform/providers.js";

export interface RuntimeAiConfig {
  aiExecutionMode: AiExecutionMode;
  aiProvider: AiProviderName;
}

export function normalizeAiExecutionMode(value: string | undefined): AiExecutionMode | undefined {
  if (value === "direct" || value === "queue") {
    return value;
  }
  return undefined;
}

export function normalizeAiProvider(value: string | undefined): AiProviderName | undefined {
  if (value === "mock" || value === "openai-compatible" || value === "azure-openai" || value === "codex" || value === "claude") {
    return value;
  }
  return undefined;
}

export function validateRuntimeAiConfig(aiExecutionMode: AiExecutionMode, aiProvider: AiProviderName): string | undefined {
  const configuredProvider = getConfiguredAiProviders().find((provider) => provider.name === aiProvider);
  if (!configuredProvider) {
    return `${aiProvider} is not configured by environment variables`;
  }
  if (aiExecutionMode === "direct" && !configuredProvider.supportsDirect) {
    return `${aiProvider} cannot be used in direct mode`;
  }
  if (aiExecutionMode === "queue" && !configuredProvider.supportsQueue) {
    return `${aiProvider} cannot be used in queue mode`;
  }
  return undefined;
}

export class RuntimeConfigHolder {
  private config: RuntimeAiConfig;

  constructor(config: RuntimeAiConfig) {
    this.config = config;
  }

  static fromEnv(): RuntimeConfigHolder {
    const aiExecutionMode = normalizeAiExecutionMode(process.env.AI_EXECUTION_MODE) ?? "direct";
    const providerFromEnv =
      process.env.AI_PROVIDER ??
      (aiExecutionMode === "queue" ? process.env.AI_JOB_PROVIDER : process.env.CHAT_PROVIDER) ??
      process.env.CHAT_PROVIDER ??
      process.env.AI_JOB_PROVIDER;
    const aiProvider = normalizeAiProvider(providerFromEnv) ?? "mock";
    const validationError = validateRuntimeAiConfig(aiExecutionMode, aiProvider);
    if (validationError) {
      throw new Error(validationError);
    }
    return new RuntimeConfigHolder({ aiExecutionMode, aiProvider });
  }

  get(): RuntimeAiConfig {
    return this.config;
  }

  /** Returns an error message string when the requested config is invalid; otherwise applies it and returns undefined. */
  update(next: { aiExecutionMode: AiExecutionMode; aiProvider: AiProviderName }): string | undefined {
    const error = validateRuntimeAiConfig(next.aiExecutionMode, next.aiProvider);
    if (error) {
      return error;
    }
    this.config = next;
    return undefined;
  }

  reset(): void {
    this.config = RuntimeConfigHolder.fromEnv().get();
  }
}
```

- [ ] **Step 2: Rewire `main.ts`**

Delete `createInitialRuntimeConfig`, `normalizeAiExecutionMode`, `normalizeAiProvider`, `validateRuntimeAiConfig`, the `RuntimeAiConfig` interface, and the `AiProviderName` type alias from `main.ts`. Replace `let runtimeConfig = createInitialRuntimeConfig();` with `const runtimeConfig = RuntimeConfigHolder.fromEnv();`. Replace every read `runtimeConfig.aiProvider`/`runtimeConfig.aiExecutionMode` with `runtimeConfig.get().aiProvider`/`.get().aiExecutionMode`. In `handleUpdateRuntimeConfig`, replace the manual reassignment with `const error = runtimeConfig.update({ aiExecutionMode: nextExecutionMode, aiProvider: nextProvider });` and branch on `error`. In `handleResetData`, replace `runtimeConfig = createInitialRuntimeConfig()` with `runtimeConfig.reset()`. Import `AiProviderName` from `./platform/providers.js` where still referenced.

- [ ] **Step 3: Verify green**

Run: `npm run -w @magpie/api typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Manual flow check**

Run the API (`npm run dev:api`), then: `curl -s localhost:4000/api/config | head` shows config; `curl -s -X POST localhost:4000/api/config -d '{"ai":{"executionMode":"direct","provider":"mock"}}' -H 'content-type: application/json'` returns 200 with the updated config; an invalid provider returns 400.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(api): replace mutable runtimeConfig with RuntimeConfigHolder"
```

---

### Task 5: Extract `BackgroundEmbedder`, repository & source-context plumbing

**Files:**
- Create: `apps/api/src/platform/background-embedder.ts`, `apps/api/src/platform/repositories.ts`, `apps/api/src/platform/source-context.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: Create `platform/background-embedder.ts`**

```ts
// apps/api/src/platform/background-embedder.ts
import { embedPendingSections } from "../stores/embed-sections.js";
import type { EmbeddingProvider } from "@magpie/core";

interface KnowledgeStoreLike {
  // structural: whatever embedPendingSections requires of the store
}

export class BackgroundEmbedder {
  private inFlight = false;
  private rerunRequested = false;

  constructor(
    private readonly store: (Parameters<typeof embedPendingSections>[0]["store"]) | undefined,
    private readonly provider: EmbeddingProvider | undefined
  ) {}

  async trigger(): Promise<void> {
    if (!this.store || !this.provider) {
      return;
    }
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    this.inFlight = true;
    try {
      do {
        this.rerunRequested = false;
        const result = await embedPendingSections({ store: this.store, provider: this.provider });
        if (result.embeddedCount > 0) {
          console.log(`Embedded ${result.embeddedCount} section(s); ${result.remaining} remaining`);
        }
      } while (this.rerunRequested);
    } catch (error) {
      console.warn(`Background embedding failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      this.inFlight = false;
    }
  }
}
```
(Drop the unused `KnowledgeStoreLike` placeholder if the concrete `store`/`provider` types from `embed-sections.ts` are importable; use those exact types instead. Do not cast through `unknown`.)

- [ ] **Step 2: Create `platform/repositories.ts`**

Move **verbatim** and export, changing each to accept its dependencies as parameters instead of reading module globals: `syncConfiguredGitCheckouts`, `uniqueConfiguredGitRepositories`, `resolveConfiguredRepositoryLocalPath`, `checkoutRoot`, `resolveLocalConfiguredPath`, `defaultDestinationId`, `selectFlow`, `destinationSubpath`, `findRepositoryForProposal`, `selectDestinationForProposal`, `findRepositoryForDestination`, `resolveIndexSelection`, `indexRepositoryForPayload`, `selectDestinationForIndex`, `configuredIndexPayloads`, `seedConfiguredKnowledge`.

Signature change pattern: functions that currently read `configuredKnowledgeDestinations`, `configuredKnowledgeSources`, `configuredKnowledgeFlows`, `configuredKnowledgeRepositories`, `knowledgeIndex`, or call `embedSectionsInBackground()` now take a single `ctx: AppContext` parameter (defined in Task 6) and read `ctx.knowledgeConfig.*`, `ctx.stores.knowledgeIndex`, `ctx.embedder.trigger()`. To avoid a forward dependency, define a local interface in `repositories.ts` describing only the slice they need and have `AppContext` satisfy it:

```ts
export interface RepositoryDeps {
  knowledgeConfig: {
    sources: ConfiguredKnowledgeRepository[];
    destinations: ConfiguredKnowledgeRepository[];
    flows: ConfiguredKnowledgeFlow[];
    repositories: ConfiguredKnowledgeRepository[];
    checkoutRoot: string;
  };
  knowledgeIndex: { indexLocalRepository: InMemoryKnowledgeIndex["indexLocalRepository"]; listRepositories: InMemoryKnowledgeIndex["listRepositories"]; };
  triggerEmbedding: () => void;
}
```
Functions take `(deps: RepositoryDeps, ...originalArgs)`.

- [ ] **Step 3: Create `platform/source-context.ts`**

Move **verbatim** and export: `collectSourceContext`, `selectSources`, `collectLocalSourceContext`, `findSourceContextFiles`, `walkSourceFiles`, `ignoredSourceEntry`, `isTextSourceFile`, `sourceFilePriority`. `collectSourceContext`/`selectSources` read `configuredKnowledgeSources` and call `resolveConfiguredRepositoryLocalPath` — pass `RepositoryDeps` (or the narrower `{ sources, ... }`) in.

- [ ] **Step 4: Rewire `main.ts`**

Delete moved definitions. Replace the `embedSectionsInBackground` function and its `embeddingInFlight`/`embeddingRerunRequested` module vars with a `BackgroundEmbedder` instance: `const embedder = new BackgroundEmbedder(knowledgeStore, embeddingProvider);` and replace `void embedSectionsInBackground()` with `void embedder.trigger()`. Update calls to the moved repository/source functions to pass the deps object (assemble a temporary inline `deps` from the existing module consts; Task 6 replaces it with `ctx`).

- [ ] **Step 5: Verify green + manual flow check**

Run: `npm run -w @magpie/api typecheck && npm run build`. Then with the API running and a configured knowledge base, `curl -s -X POST localhost:4000/api/repositories/index -d '{}' -H 'content-type: application/json'` indexes successfully and `curl -s 'localhost:4000/api/search?q=test'` returns results.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(api): extract background embedder, repository and source-context plumbing"
```

---

### Task 6: Composition root `AppContext`

**Files:**
- Create: `apps/api/src/context.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: Create `context.ts`**

```ts
// apps/api/src/context.ts
import type { EmbeddingProvider } from "@magpie/core";
import { RuntimeConfigHolder } from "./config-holder.js";
import { BackgroundEmbedder } from "./platform/background-embedder.js";
import {
  createAiJobQueue, createCrunchStore, createProposalStore,
  createQuestionLogStore, createScheduledTaskStore, parseClaimTimeoutMs, requireDatabaseUrl, storeBackend
} from "./platform/stores.js";
import { createConfiguredChatProvider, createConfiguredEmbeddingProvider, type AiProviderName } from "./platform/providers.js";
import { InMemoryKnowledgeIndex } from "./stores/knowledge-index.js";
import { PostgresKnowledgeStore } from "./stores/postgres-knowledge-store.js";
import {
  getConfiguredKnowledgeDestinations, getConfiguredKnowledgeFlows,
  getConfiguredKnowledgeRepositories, getConfiguredKnowledgeSources,
  type ConfiguredKnowledgeFlow, type ConfiguredKnowledgeRepository
} from "./stores/knowledge-repositories.js";
import { syncConfiguredGitCheckouts, checkoutRoot, type RepositoryDeps } from "./platform/repositories.js";
import type { ChatProvider } from "@magpie/core";

export interface AppContext {
  stores: {
    knowledge: PostgresKnowledgeStore | undefined;
    knowledgeIndex: InMemoryKnowledgeIndex;
    questionLogs: ReturnType<typeof createQuestionLogStore>;
    proposals: ReturnType<typeof createProposalStore>;
    crunchRuns: ReturnType<typeof createCrunchStore>;
    scheduledTasks: ReturnType<typeof createScheduledTaskStore>;
    aiJobs: ReturnType<typeof createAiJobQueue>;
  };
  providers: {
    chat: (provider: AiProviderName) => ChatProvider;
    embedding: EmbeddingProvider | undefined;
  };
  config: RuntimeConfigHolder;
  knowledgeConfig: {
    sources: ConfiguredKnowledgeRepository[];
    destinations: ConfiguredKnowledgeRepository[];
    flows: ConfiguredKnowledgeFlow[];
    repositories: ConfiguredKnowledgeRepository[];
    checkoutRoot: string;
  };
  embedder: BackgroundEmbedder;
  /** Narrow slice for platform/repositories + source-context helpers. */
  repositoryDeps(): RepositoryDeps;
  bootstrap(): Promise<void>;
}

export async function createAppContext(): Promise<AppContext> {
  const claimTimeoutMs = parseClaimTimeoutMs(process.env.AI_JOB_CLAIM_TIMEOUT_MS);
  const knowledgeStore = storeBackend("KNOWLEDGE_STORE") === "postgres"
    ? new PostgresKnowledgeStore(requireDatabaseUrl())
    : undefined;
  const embedding = knowledgeStore ? createConfiguredEmbeddingProvider() : undefined;
  const knowledgeIndex = knowledgeStore
    ? new InMemoryKnowledgeIndex(knowledgeStore, embedding
        ? { embeddingProvider: embedding, vectorSearch: knowledgeStore, onNotice: (m) => console.warn(m) }
        : {})
    : new InMemoryKnowledgeIndex();

  const sources = getConfiguredKnowledgeSources();
  const destinations = getConfiguredKnowledgeDestinations();
  const knowledgeConfig = {
    sources,
    destinations,
    repositories: getConfiguredKnowledgeRepositories(),
    flows: getConfiguredKnowledgeFlows(process.env, sources, destinations),
    checkoutRoot: checkoutRoot()
  };

  const embedder = new BackgroundEmbedder(knowledgeStore, embedding);

  const ctx: AppContext = {
    stores: {
      knowledge: knowledgeStore,
      knowledgeIndex,
      questionLogs: createQuestionLogStore(),
      proposals: createProposalStore(),
      crunchRuns: createCrunchStore(),
      scheduledTasks: createScheduledTaskStore(),
      aiJobs: createAiJobQueue(claimTimeoutMs)
    },
    providers: {
      chat: (provider) => createConfiguredChatProvider(provider),
      embedding
    },
    config: RuntimeConfigHolder.fromEnv(),
    knowledgeConfig,
    embedder,
    repositoryDeps() {
      return {
        knowledgeConfig,
        knowledgeIndex,
        triggerEmbedding: () => void embedder.trigger()
      };
    },
    async bootstrap() {
      await syncConfiguredGitCheckouts(this.repositoryDeps());
      await knowledgeIndex.hydrate();
    }
  };
  return ctx;
}
```
(Use the real store union types if the `ReturnType<...>` aliases prove awkward; the point is no `unknown` casts.)

- [ ] **Step 2: Rewire `main.ts` to build and use the context**

Replace the module-level store/provider/config consts with `const ctx = await createAppContext();` inside `start()`. Pass `ctx` into the route dispatcher and every handler (handlers still live in `main.ts` for now — change them to read `ctx.stores.*`, `ctx.providers.chat(...)`, `ctx.config.get()`, `ctx.repositoryDeps()`). The platform repository/source functions now receive `ctx.repositoryDeps()`. `start()` calls `await ctx.bootstrap()` in place of the separate `syncConfiguredGitCheckouts()` + `knowledgeIndex.hydrate()` calls.

- [ ] **Step 3: Verify green + full manual flow checklist**

Run: `npm run -w @magpie/api typecheck && npm run build && npm run -w @magpie/api test`. Then run the API and walk the **manual flow checklist** (see Phase 4 Task 13 list) — this is the first point where all wiring goes through the context.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(api): introduce AppContext composition root, retire module globals"
```

---

## Phase 1 — Extract feature services

> Pattern for every feature task: create `features/<x>/service.ts` exporting functions that take `ctx: AppContext` (first arg) plus the original inputs; move the relevant bodies **verbatim** from `main.ts`; rewrite the `main.ts` handler to a thin wrapper that parses input, calls the service, and writes the response exactly as before. Routes are NOT moved to Hono yet (Task 12). Verify green + the named manual flow after each.

### Task 7: `ask` and `knowledge` services

**Files:**
- Create: `apps/api/src/features/ask/service.ts`, `apps/api/src/features/knowledge/service.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: `features/ask/service.ts`**

Export `async function ask(ctx: AppContext, question: string)`. Move the body of `handleAsk` (minus the HTTP request/response handling and the `question_required` 400) — return a discriminated result: `{ mode: "queue"; questionId; job }` or `{ mode: "direct" | ...; questionId; result }`. The `main.ts` `handleAsk` becomes: validate question → `const out = await ask(ctx, question)` → `writeJson` with the same envelopes/status codes (202 for queue, 200 for direct) it uses today.

- [ ] **Step 2: `features/knowledge/service.ts`**

Export: `indexRepository(ctx, payload)`, `uploadDocuments(ctx, payload)`, `search(ctx, query, limit)`, plus thin pass-throughs `listRepositories(ctx)`, `listDocuments(ctx)`, `stats(ctx)`. Move the bodies of `handleIndexRepository` (service part), `handleUploadDocuments`, and the inline `/search` logic. The repository-resolution calls go through `ctx.repositoryDeps()`. Keep `knowledgeRepositoryErrorCode` next to `indexRepository` (move it from `main.ts`).

- [ ] **Step 3: Rewire `main.ts` handlers to call the services**

- [ ] **Step 4: Verify green + manual flow**

Run typecheck/build/test. Manual: ask (direct + queue), index a repo, upload a doc, search, `/knowledge/stats`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(api): extract ask and knowledge services"
```

---

### Task 8: `questions` and `gaps` services

**Files:**
- Create: `apps/api/src/features/questions/service.ts`, `apps/api/src/features/gaps/service.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: `features/questions/service.ts`**

Export: `recordFeedback(ctx, questionId, feedback)`, `recordManualGap(ctx, questionId, summary)`, `clearManualGap(ctx, questionId)`, `getQuestion(ctx, id)`, `listQuestions(ctx, limit)`, and the `isQuestionFeedback` guard (the `feedback` Zod enum in `schema.ts` supersedes it at the HTTP edge, but keep it for any internal use; delete if unreferenced after Task 12). Move bodies from `handleQuestionFeedback`, `handleRecordManualGap`, `handleClearManualGap`.

- [ ] **Step 2: `features/gaps/service.ts`**

Export: `listCandidates(ctx, limit)`, `listClusters(ctx, limit)`, and the helpers `clusterGapCandidates(ctx, candidates)`, `requestGapClusters(ctx, candidates)`. Move verbatim; `requestGapClusters` uses `ctx.providers.chat(ctx.config.get().aiProvider)`.

- [ ] **Step 3: Rewire `main.ts`; Step 4: verify green + manual flow** (feedback → manual gap → candidate appears → clusters endpoint). **Step 5: commit** `refactor(api): extract questions and gaps services`.

---

### Task 9: `proposals` and `config` services

**Files:**
- Create: `apps/api/src/features/proposals/service.ts`, `apps/api/src/features/config/service.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: `features/proposals/service.ts`**

Export: `list(ctx, limit, options)`, `get(ctx, id)`, `updateStatus(ctx, id, status)`, `publish(ctx, id)`, `draftFromGaps(ctx, summaries, overrides)`, and the merge-cascade group `runMergeCascade(ctx, proposal)`, `resolveGapsForMergedProposal(ctx, proposal)`, `reindexDestinationForProposal(ctx, proposal)`, `publishReadyProposal(ctx, proposal)`. Move the proposal helpers too: `buildPullRequestBody`, `createProposalBranchName`, `dedupeCitations`, `joinGapSummaries`, `splitGapSummaries`, `draftMarkdownProposalDirect(ctx, input)`, `createMockMarkdownProposal`, `titleFromGapSummary`, `parseJsonObject`, and the `isProposalStatus` guard (used by the list route's `status` query filter and by `updateStatus`). Keep the discriminated `{ ok: false, code, message } | { ok: true, ... }` returns for the functions shared with schedulers — the HTTP edge maps them.

- [ ] **Step 2: `features/config/service.ts`**

Export: `getRuntimeConfig(ctx)`, `logStartupConfig(ctx)`, `resetData(ctx)` (the body of `handleResetData`, calling `seedConfiguredKnowledge(ctx.repositoryDeps())`), plus `maskConnectionString`, `secretState`. `getRuntimeConfig` reads from `ctx` (`ctx.config.get()`, `ctx.knowledgeConfig`, `getConfiguredAiProviders()`, `retrievalMode()`).

- [ ] **Step 3: Rewire `main.ts`; Step 4: verify green + manual flow** (list/get/status/publish proposal; mark merged → merge cascade resolves gaps + re-indexes; `/config`; `/admin/reset`). **Step 5: commit** `refactor(api): extract proposals and config services`.

---

### Task 10: `crunch` and `jobs` services

**Files:**
- Create: `apps/api/src/features/crunch/service.ts`, `apps/api/src/features/jobs/service.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: `features/crunch/service.ts`**

Export: `listRuns(ctx, limit)`, `getRun(ctx, id)`, `triggerCrunchRun(ctx, options)`, `publishRun(ctx, runId)`, `settingsForResponse(ctx)`, `updateSettings(ctx, flowId, settings)`, plus helpers `gatherCrunchDocuments(ctx, destinationId)`, `crunchKnowledgeBaseDirect(ctx, input)`, `attachCrunchPlanFromCompletedJob(ctx, job, output)`, `isCrunchPlan`, `changesetFromPlan`, `crunchBranchName`. Move `DEFAULT_CRUNCH_CRON` usage stays imported from `../../stores/crunch-store.js`.

- [ ] **Step 2: `features/jobs/service.ts`**

Export: `createJob(ctx, type, input)`, `claimJob(ctx, workerName, acceptedTypes)`, `completeJob(ctx, jobId, output)`, `failJob(ctx, jobId, error)`, `getJob(ctx, id)`, `listJobs(ctx)`, and the type guards as Zod-validated helpers `isAiJobType`, `isAnswerQuestionJobOutput`, `isDraftMarkdownProposalJobOutput` (move now; convert to Zod in Task 12). `completeJob` is the **dispatcher**: after `ctx.stores.aiJobs.complete(...)`, it calls `updateQuestionLogFromCompletedJob(ctx, job, output)` (move here), `proposalsService.createFromCompletedJob(ctx, job, output)` (move `createProposalFromCompletedJob` into proposals service, re-export, import here), and `crunchService.attachCrunchPlanFromCompletedJob(ctx, job, output)`. Cross-feature imports are allowed (jobs → proposals/crunch/questions services).

- [ ] **Step 3: Rewire `main.ts`; Step 4: verify green + manual flow** (create/claim/complete/fail a job in queue mode end-to-end via a running watcher or curl; crunch manual run → publish). **Step 5: commit** `refactor(api): extract crunch and jobs services`.

---

## Phase 2 — Extract schedulers

### Task 11: `scheduling/` + `http/errors.ts`

**Files:**
- Create: `apps/api/src/scheduling/task-registry.ts`, `apps/api/src/scheduling/crunch-scheduler.ts`, `apps/api/src/scheduling/task-scheduler.ts`, `apps/api/src/http/errors.ts`
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: `http/errors.ts`**

```ts
// apps/api/src/http/errors.ts
import type { Context } from "hono";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message?: string) {
    super(message ?? code);
  }
}

export function onError(error: Error, c: Context) {
  if (error instanceof HttpError) {
    return c.json({ error: error.code, ...(error.message && error.message !== error.code ? { message: error.message } : {}) }, error.status as never);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return c.json({ error: "internal_error", message }, 500);
}
```

- [ ] **Step 2: `scheduling/task-registry.ts`**

Move the `ScheduledTaskDefinition` interface and `scheduledTaskDefinitions` array. Its two handlers (`refreshPullRequests`, `processGapsIntoPullRequests`) and `coveredGapSummaries` move here but take `ctx` and **delegate to feature services** (`proposalsService.updateStatus/list/publishReadyProposal/runMergeCascade`, `gapsService.clusterGapCandidates`, `proposalsService.draftFromGaps`). Build the registry as a function `buildTaskRegistry(ctx): ScheduledTaskDefinition[]`. Move `findScheduledTask`, `defaultScheduledTaskSettings`, `scheduledTasksForResponse`.

- [ ] **Step 3: `scheduling/crunch-scheduler.ts` and `task-scheduler.ts`**

Each is a class taking `ctx` (and, for tasks, the registry). Move `startCrunchScheduler`+`crunchSchedulerTick` and `startScheduledTaskScheduler`+`scheduledTaskTick`; the `*TickInFlight` module flags become private instance fields. Expose `start(): void`.

- [ ] **Step 4: Rewire `main.ts`**

`main.ts` constructs the schedulers from `ctx` and calls `.start()` in the `listen` callback. The scheduled-task HTTP handlers (`handleUpdateScheduledTaskSettings`, `handleRunScheduledTask`) call the registry built from `ctx`.

- [ ] **Step 5: Verify green + manual flow**

Typecheck/build/test. Manual: trigger a scheduled-task run via `POST /api/scheduled-tasks/pull-request-refresh/run` and `.../gaps-to-pull-requests/run`; confirm crunch settings save and the scheduler logs a tick.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(api): extract schedulers and HttpError layer"
```

---

## Phase 3 — Swap the HTTP edge to Hono + Zod

### Task 12: Hono app, per-feature routes & Zod schemas

**Files:**
- Create: `apps/api/src/app.ts`; `apps/api/src/features/<x>/routes.ts` and `schema.ts` for all 8 features
- Modify: `apps/api/src/main.ts` (becomes the thin entrypoint)

- [ ] **Step 1: Write Zod schemas per feature**

Create `features/<x>/schema.ts`. Examples (write the real schema for every request body/query used by that feature):

```ts
// features/ask/schema.ts
import { z } from "zod";
export const askBody = z.object({ question: z.string().trim().min(1) });

// features/proposals/schema.ts
import { z } from "zod";
export const statusValues = ["draft", "ready", "branch-pushed", "pr-opened", "merged", "rejected"] as const;
export const updateStatusBody = z.object({ status: z.enum(statusValues) });
export const fromGapsBody = z.object({
  summary: z.string().optional(),
  summaries: z.array(z.string()).optional(),
  targetPath: z.string().optional(),
  flowId: z.string().optional(),
  sourceIds: z.array(z.string()).optional(),
  destinationId: z.string().optional()
});

// shared query schema
export const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });
```
Also write the **job-output** schemas in `features/jobs/schema.ts` (`answerQuestionOutput`, `draftMarkdownProposalOutput`) and `features/crunch/schema.ts` (`crunchPlan`) to replace the hand-rolled guards; the jobs dispatcher uses `schema.safeParse(output)`.

- [ ] **Step 2: Write `features/<x>/routes.ts`**

Each exports a function `(ctx: AppContext) => Hono`. Handlers call the service and return the **exact** envelopes/status codes the old `writeJson` calls used. Example:

```ts
// features/proposals/routes.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { HttpError } from "../../http/errors.js";
import * as service from "./service.js";
import { fromGapsBody, limitQuery, updateStatusBody } from "./schema.js";

export function proposalRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/", zValidator("query", limitQuery), async (c) => {
    const { limit } = c.req.valid("query");
    const statusFilter = c.req.query("status");
    const options = service.isProposalStatus(statusFilter) ? { status: statusFilter } : undefined;
    return c.json({ proposals: await service.list(ctx, limit ?? 50, options) });
  });

  const draft = async (c) => {
    const body = c.req.valid("json");
    const requested = [...(body.summaries ?? []), ...(body.summary ? [body.summary] : [])];
    const outcome = await service.draftFromGaps(ctx, requested, body);
    if (!outcome.ok) {
      throw new HttpError(outcome.code === "gap_summary_required" ? 400 : 404, outcome.code);
    }
    return outcome.mode === "direct"
      ? c.json({ proposal: outcome.proposal }, 201)
      : c.json({ job: outcome.job, links: { status: `/api/ai-jobs/${outcome.job.id}`, proposals: "/api/proposals" } }, 202);
  };
  // Both legacy /from-gap and /from-gaps share one validated handler.
  app.post("/from-gap", zValidator("json", fromGapsBody), draft);
  app.post("/from-gaps", zValidator("json", fromGapsBody), draft);

  app.get("/:id", async (c) => {
    const proposal = await service.get(ctx, c.req.param("id"));
    if (!proposal) throw new HttpError(404, "proposal_not_found");
    return c.json({ proposal });
  });

  app.post("/:id/status", zValidator("json", updateStatusBody), async (c) => {
    const result = await service.updateStatus(ctx, c.req.param("id"), c.req.valid("json").status);
    if (!result) throw new HttpError(404, "proposal_not_found");
    return c.json(result);
  });

  app.post("/:id/publish", async (c) => {
    const outcome = await service.publish(ctx, c.req.param("id"));
    if (!outcome.ok) throw new HttpError(outcome.status ?? 409, outcome.code, outcome.message);
    return c.json(outcome.body);
  });

  return app;
}
```
(Delete the malformed `drafting` placeholder above — register `/from-gap` and `/from-gaps` both to the same validated handler. Repeat this style for ask, knowledge, questions, gaps, crunch, jobs, config routes, matching every route and response in today's `route()` ladder. `service.publish`/`updateStatus` may need small shape tweaks to return `{ ok, status, code, message, body }` for the edge to map — adjust the service accordingly.)

- [ ] **Step 3: Write `app.ts`**

```ts
// apps/api/src/app.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppContext } from "./context.js";
import { onError } from "./http/errors.js";
import { askRoutes } from "./features/ask/routes.js";
import { knowledgeRoutes } from "./features/knowledge/routes.js";
import { questionRoutes } from "./features/questions/routes.js";
import { gapRoutes } from "./features/gaps/routes.js";
import { proposalRoutes } from "./features/proposals/routes.js";
import { crunchRoutes } from "./features/crunch/routes.js";
import { jobRoutes } from "./features/jobs/routes.js";
import { configRoutes } from "./features/config/routes.js";

export function buildApp(ctx: AppContext) {
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], allowHeaders: ["content-type"] }));
  app.onError(onError);

  const api = new Hono();
  api.get("/health", (c) => c.json({ ok: true, service: "markdown-magpie-api" }));
  api.route("/", configRoutes(ctx));        // /config, /admin/reset
  api.route("/", askRoutes(ctx));            // /ask
  api.route("/", knowledgeRoutes(ctx));      // /repositories, /documents, /search, /knowledge/stats
  api.route("/questions", questionRoutes(ctx));
  api.route("/gaps", gapRoutes(ctx));
  api.route("/proposals", proposalRoutes(ctx));
  api.route("/crunch", crunchRoutes(ctx));
  api.route("/scheduled-tasks", /* from jobs/scheduling */ jobRoutes(ctx)); // see note
  api.route("/ai-jobs", jobRoutes(ctx));

  app.route("/api", api);
  return app;
}
```
(Mount scheduled-task routes from wherever Task 11 placed their handlers — likely a small `scheduling/routes.ts`; add it. Match exact paths: `/repositories/index`, `/documents/upload`, etc. live inside the knowledge router with those subpaths.)

- [ ] **Step 4: Rewrite `main.ts` to the thin entrypoint**

```ts
// apps/api/src/main.ts
import { serve } from "@hono/node-server";
import { createAppContext } from "./context.js";
import { buildApp } from "./app.js";
import { logStartupConfig } from "./features/config/service.js";
import { CrunchScheduler } from "./scheduling/crunch-scheduler.js";
import { TaskScheduler } from "./scheduling/task-scheduler.js";

const port = Number.parseInt(process.env.PORT ?? "4000", 10);

async function start() {
  const ctx = await createAppContext();
  try {
    await ctx.bootstrap();
  } catch (error) {
    console.error(`Bootstrap failed: ${error instanceof Error ? error.message : "unknown"}`);
    process.exitCode = 1;
    return;
  }
  const app = buildApp(ctx);
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Markdown Magpie API listening on http://localhost:${port}/api`);
    logStartupConfig(ctx);
    new CrunchScheduler(ctx).start();
    new TaskScheduler(ctx).start();
  });
}

void start();
```
Delete the now-dead `createServer`, `route`, `writeJson`, `readJsonBody`, `apiRoutePath`, all `handleX` functions, and the type guards from `main.ts`. `readJsonBody` is replaced by Zod; remove it. After this step `main.ts` should be ~30 lines.

- [ ] **Step 5: Convert job-output guards to Zod in the dispatcher**

In `features/jobs/service.ts`, replace `isAnswerQuestionJobOutput`/`isDraftMarkdownProposalJobOutput`/`isCrunchPlan` usage with `schema.safeParse(output).success` from the feature schemas. Delete the hand-rolled guards.

- [ ] **Step 6: Verify green + FULL manual flow checklist**

Run: `npm run -w @magpie/api typecheck && npm run build && npm run -w @magpie/api test`. Then run the API and execute the entire **manual flow checklist** (Task 13). Pay special attention to: `OPTIONS` returns 204-equivalent (Hono cors handles preflight — confirm `curl -i -X OPTIONS localhost:4000/api/ask` returns 204 with the CORS headers); unknown route returns `{ error: "not_found" }` 404 (add `app.notFound((c) => c.json({ error: "not_found" }, 404))` to match today); `/api` (root) maps to health-or-404 as before.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor(api): swap HTTP edge to Hono + Zod, main.ts is now a thin entrypoint"
```

---

## Phase 4 — Test the new layer

### Task 13: Service unit tests + router smoke tests + manual checklist

**Files:**
- Create: `apps/api/src/features/proposals/service.test.ts`, `apps/api/src/features/ask/service.test.ts`, `apps/api/src/features/jobs/service.test.ts`, `apps/api/src/features/crunch/service.test.ts`, `apps/api/src/app.test.ts`
- Create: `apps/api/src/test-support/context.ts` (builds an `AppContext` with in-memory stores + mock provider)

- [ ] **Step 1: Test-support context builder**

```ts
// apps/api/src/test-support/context.ts
import type { AppContext } from "../context.js";
import { RuntimeConfigHolder } from "../config-holder.js";
import { BackgroundEmbedder } from "../platform/background-embedder.js";
import { InMemoryKnowledgeIndex } from "../stores/knowledge-index.js";
import { InMemoryProposalStore } from "../stores/proposal-store.js";
import { InMemoryQuestionLogStore } from "../stores/question-log-store.js";
import { InMemoryCrunchStore } from "../stores/crunch-store.js";
import { InMemoryScheduledTaskStore } from "../stores/scheduled-task-store.js";
import { InMemoryAiJobQueue } from "../stores/ai-job-queue.js";

export function makeTestContext(overrides: Partial<AppContext> = {}): AppContext {
  const knowledgeIndex = new InMemoryKnowledgeIndex();
  const embedder = new BackgroundEmbedder(undefined, undefined);
  const knowledgeConfig = { sources: [], destinations: [], flows: [], repositories: [], checkoutRoot: "/tmp" };
  const ctx: AppContext = {
    stores: {
      knowledge: undefined,
      knowledgeIndex,
      questionLogs: new InMemoryQuestionLogStore(),
      proposals: new InMemoryProposalStore(),
      crunchRuns: new InMemoryCrunchStore(),
      scheduledTasks: new InMemoryScheduledTaskStore(),
      aiJobs: new InMemoryAiJobQueue(60_000)
    },
    providers: { chat: () => ({ async complete() { return { content: '{"title":"T","targetPath":"t.md","markdown":"# T","rationale":"r"}' }; } }) as never, embedding: undefined },
    config: new RuntimeConfigHolder({ aiExecutionMode: "direct", aiProvider: "mock" }),
    knowledgeConfig,
    embedder,
    repositoryDeps: () => ({ knowledgeConfig, knowledgeIndex, triggerEmbedding: () => {} }),
    bootstrap: async () => {},
    ...overrides
  };
  return ctx;
}
```
(Replace the `as never` on the chat provider with a properly-typed minimal `ChatProvider` stub — do not ship `as never`. Define a `function stubChat(): ChatProvider` returning a typed object.)

- [ ] **Step 2: Write `proposals/service.test.ts` — merge cascade**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../../test-support/context.js";
import * as proposals from "./service.js";

test("runMergeCascade resolves recorded gaps for a merged proposal", async () => {
  const ctx = makeTestContext();
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?", executionMode: "direct", chatProvider: "mock", retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
  const proposal = await ctx.stores.proposals.create({
    title: "Configuring X", targetPath: "x.md", markdown: "# X", rationale: "r",
    evidence: [], gapSummary: "How to configure X", triggeringQuestionIds: [log.id]
  });

  const { resolvedGapCount } = await proposals.runMergeCascade(ctx, { ...proposal, status: "merged" });

  assert.equal(resolvedGapCount, 1);
  const remaining = await ctx.stores.questionLogs.listGapCandidates(50);
  assert.equal(remaining.length, 0);
});
```

- [ ] **Step 3: Run it**

Run: `npm run -w @magpie/api test`
Expected: PASS. (If the store method names differ, align the test to the real `QuestionLogStore`/`ProposalStore` interfaces.)

- [ ] **Step 4: Write `ask/service.test.ts`**

Cover both modes: direct returns `{ mode: "direct", result }` and records a log with an answer; queue returns `{ mode: "queue", job }` and enqueues an `answer_question` job. Use `makeTestContext()` (mock provider) for direct; set `ctx.config.update({ aiExecutionMode: "queue", aiProvider: "mock" })` for queue.

- [ ] **Step 5: Write `jobs/service.test.ts` — completion dispatcher**

Enqueue a `draft_markdown_proposal` job, complete it with a valid output object, assert a proposal was created via the dispatcher. Complete an `answer_question` job, assert the question log gains the answer. Complete a `crunch_knowledge_base` job, assert the run is marked completed.

- [ ] **Step 6: Write `crunch/service.test.ts`**

`triggerCrunchRun` in direct+mock mode returns a completed run with a plan; `changesetFromPlan` flattens deletes-then-writes with last-write-wins on a shared path (port the comment's invariant into an assertion).

- [ ] **Step 7: Write `app.test.ts` — router smoke tests**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "./test-support/context.js";
import { buildApp } from "./app.js";

test("GET /api/health returns ok", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "markdown-magpie-api" });
});

test("POST /api/ask with empty question returns 400", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/ask", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "" })
  });
  assert.equal(res.status, 400);
});

test("unknown route returns not_found", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/api/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});
```
(`app.request(...)` is Hono's built-in test helper — no server needed.)

- [ ] **Step 8: Run full suite + build + typecheck**

Run: `npm run -w @magpie/api typecheck && npm run build && npm run -w @magpie/api test`
Expected: PASS.

- [ ] **Step 9: Manual flow checklist (final sign-off)**

With `npm run dev:api` running against the in-memory backend, confirm each:
- [ ] ask — direct mode returns an answer; queue mode returns 202 + job
- [ ] index a configured repository; `/search?q=...` returns sections; `/knowledge/stats` non-zero
- [ ] feedback → manual gap → `/gaps/candidates` shows it; `/gaps/clusters` returns clusters
- [ ] draft proposal from one gap and from a cluster (`/proposals/from-gaps`)
- [ ] publish a ready proposal → branch pushed / PR raised (or graceful no-token path)
- [ ] mark a proposal merged → gaps resolved + destination re-indexed
- [ ] crunch manual run → publish the run
- [ ] scheduled-task manual run for both `pull-request-refresh` and `gaps-to-pull-requests`
- [ ] `OPTIONS /api/ask` → 204 + CORS headers; unknown route → `{ error: "not_found" }`

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "test(api): add service unit tests and router smoke tests"
```

---

## Done

`main.ts` is a ~30-line entrypoint; domain logic lives in testable feature services over a `platform/` kernel; the HTTP edge is Hono + Zod; all module-level mutable state is gone. Behaviour is unchanged: same routes, envelopes, and status codes. Open a PR from `refactor/api-decomposition` into `main`.
```
