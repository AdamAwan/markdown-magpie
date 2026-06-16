# API Decomposition — Design

**Date:** 2026-06-16
**Status:** Approved (pending implementation plan)
**Scope:** `apps/api` only. Breaking up the 2,892-line `apps/api/src/main.ts` god module into a composition root, a feature-organised service layer, and a Hono-based HTTP edge.

## Background

Markdown Magpie began as a POC and grew. Its macro-architecture is sound — an npm-workspace monorepo with clean, type-only package layering (`packages/{core,retrieval,git,markdown,jobs}` fanning in to `@magpie/core`, no cycles) and a real provider-neutral interface strategy. The rot is concentrated in two god-files. This spec addresses the first and highest-leverage one: the API entrypoint.

`apps/api/src/main.ts` is simultaneously the HTTP server, a hand-rolled regex router (~25 routes, a 250-line `route()` ladder), every request handler, all domain logic (merge cascade, gap→PR pipeline, crunch planning, proposal drafting, mock providers), config resolution + secret masking, six store factories, two cron schedulers, type guards, and path utilities. It relies on module-level mutable singletons (`let runtimeConfig`, the store consts, `embeddingInFlight` / `crunchTickInFlight` / `scheduledTaskTickInFlight`). The valuable domain logic is therefore reachable only through a live HTTP socket and is effectively untestable.

This is a behaviour-preserving restructure: the goal is to move code, not change what the API does.

## Goals

- Decompose `main.ts` into focused units, each with one clear purpose, communicating through explicit interfaces.
- Make the domain logic (merge cascade, gap→PR, crunch planning, proposal drafting) unit-testable in isolation, without HTTP or a live database.
- Retire all module-level mutable state in favour of an explicit, injected `AppContext`.
- Replace the hand-rolled router and validation with established libraries (Hono, Zod).
- Preserve external behaviour exactly — same routes, same JSON request/response envelopes, same status codes — because the web, MCP, and watcher clients have those shapes hand-coded.

## Non-Goals (each a future spec)

- A shared `@magpie/contracts` wire-types package (the Zod schemas here are designed to be liftable into it later, but it is not built now).
- Any change to the `apps/web`, `apps/mcp`, or `apps/watcher` clients.
- Store-layer changes: connection-pool consolidation, a shared transaction helper, de-duplicating in-memory vs Postgres logic.
- Splitting `knowledge-index.ts`.
- Moving cron parsing / the mock crunch-plan builder out of `@magpie/core`.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Organisation | **Feature-first (vertical slices)** | ~7 domains with heavy shared plumbing; keeps "everything about proposals" in one place and scales. |
| HTTP framework | **Hono** + `@hono/node-server` | TS-first, tiny, runs on `node:http`, clean middleware; closest to the existing lean setup while properly maintained. |
| Validation | **Zod** + `@hono/zod-validator` | Replaces scattered hand-rolled type guards; schemas double as validation for watcher job-output and are liftable into a future contracts package. |
| Refactor safety | **Extract first, test the new layer after** | User's chosen trade-off. Compensated by an always-green incremental sequence and a manual flow-verification checklist. |

## Architecture

### Target module structure

```
apps/api/src/
  main.ts                 # entrypoint: build context, bootstrap, serve, start schedulers
  app.ts                  # Hono app: mounts feature routers under /api, cors(), onError
  context.ts              # AppContext type + createAppContext() composition root
  config-holder.ts        # RuntimeConfigHolder (mutable runtime AI config)
  http/
    errors.ts             # HttpError class + onError mapping to { error, message }
  features/
    ask/         { routes.ts, schema.ts, service.ts }
    knowledge/   { routes.ts, schema.ts, service.ts }   # index, upload, documents, search, stats, repositories
    questions/   { routes.ts, schema.ts, service.ts }   # questions, feedback, manual gaps
    gaps/        { routes.ts, schema.ts, service.ts }   # candidates, clusters
    proposals/   { routes.ts, schema.ts, service.ts }
    crunch/      { routes.ts, schema.ts, service.ts }
    jobs/        { routes.ts, schema.ts, service.ts }   # AI job CRUD + completion dispatcher
    config/      { routes.ts, schema.ts, service.ts }   # /config, /admin/reset
  scheduling/
    crunch-scheduler.ts
    task-scheduler.ts
    task-registry.ts       # scheduledTaskDefinitions; handlers delegate to feature services
  platform/
    stores.ts              # 6 store factories + storeBackend/storageBackend
    providers.ts           # chat/embedding factories, embeddingProviderName, retrievalMode
    repositories.ts        # repository/destination/flow resolution, git checkout sync
    source-context.ts      # collectSourceContext + file-walking helpers
    background-embedder.ts # BackgroundEmbedder (owns in-flight/rerun flags)
    paths.ts               # normalizeRelativePath, toPosixPath, slugify, normalizeUploadPath, parseLimit, apiLink
  stores/                  # existing *-store.ts and postgres-*.ts moved here, unchanged
  knowledge-index.ts       # unchanged (split is out of scope)
```

### Composition root & `AppContext`

`context.ts` defines `AppContext` and `createAppContext()`. The composition root runs the existing store/provider factory logic (moved to `platform/`) exactly once and returns a single object passed inward. No module-level singletons remain.

```ts
interface AppContext {
  stores: {
    knowledge: KnowledgeStore | undefined;
    knowledgeIndex: KnowledgeIndex;
    questionLogs: QuestionLogStore;
    proposals: ProposalStore;
    crunchRuns: CrunchStore;
    scheduledTasks: ScheduledTaskStore;
    aiJobs: AiJobQueue;
  };
  providers: {
    chat(provider: AiProviderName): ChatProvider;   // wraps createConfiguredChatProvider
    embedding: EmbeddingProvider | undefined;
  };
  config: RuntimeConfigHolder;
  knowledgeConfig: { sources; destinations; flows; repositories; checkoutRoot };
  embedder: BackgroundEmbedder;
  bootstrap(): Promise<void>;   // syncConfiguredGitCheckouts + knowledgeIndex.hydrate
}
```

Services and route factories receive `AppContext` (or only the slice they need) as a parameter. They import no global state.

**`RuntimeConfigHolder`** (`config-holder.ts`) — the one piece of genuinely mutable runtime state. A small class wrapping `{ aiExecutionMode, aiProvider }` with `get()`, `update()`, and validation, replacing `let runtimeConfig`. `POST /config` calls `context.config.update(...)`. Unit-testable in isolation.

**`BackgroundEmbedder`** (`platform/background-embedder.ts`) — owns `embedSectionsInBackground` plus its `inFlight` / `rerunRequested` flags (today loose module vars). Services call `context.embedder.trigger()`.

**`main.ts`** final shape:

```ts
const context = await createAppContext();
await context.bootstrap();
const app = buildApp(context);
serve({ fetch: app.fetch, port }, () => {
  logStartupConfig(context);
  startSchedulers(context);
});
```

### Feature slices — mapping from today's `main.ts`

Each feature's `service.ts` holds logic and takes `AppContext`; `routes.ts` is thin Hono handlers; `schema.ts` is Zod.

- **ask/** — `handleAsk` (direct vs queue branches) → `askService.ask(question)`: `answerQuestion` directly, or enqueue an `answer_question` job; records the question log.
- **knowledge/** — `handleIndexRepository`, `handleUploadDocuments`, `resolveIndexSelection`, `indexRepositoryForPayload`, `selectDestinationForIndex`, `seedConfiguredKnowledge`, `configuredIndexPayloads`; read routes `/repositories`, `/documents`, `/knowledge/stats`, `/search`.
- **questions/** — `/questions`, `/questions/:id`, feedback, manual gaps: `handleQuestionFeedback`, `handleRecordManualGap`, `handleClearManualGap`.
- **gaps/** — `/gaps/candidates`, `/gaps/clusters`: `clusterGapCandidates`, `requestGapClusters`.
- **proposals/** — `runMergeCascade`, `resolveGapsForMergedProposal`, `reindexDestinationForProposal`, `publishReadyProposal`, `buildPullRequestBody`, `draftProposalFromGapSummaries`, `createProposalBranchName`, citation/summary helpers (`dedupeCitations`, `join`/`splitGapSummaries`), direct/mock drafting (`draftMarkdownProposalDirect`, `createMockMarkdownProposal`, `titleFromGapSummary`); routes: list, from-gap(s), get, status, publish.
- **crunch/** — `triggerCrunchRun`, `gatherCrunchDocuments`, `crunchKnowledgeBaseDirect`, `changesetFromPlan`, `findRepositoryForDestination`, `crunchBranchName`, `isCrunchPlan`, settings handlers, run publish.
- **jobs/** — AI job CRUD plus the completion dispatcher: `handleCompleteJob` becomes a small dispatcher calling `updateQuestionLogFromCompletedJob`, `createProposalFromCompletedJob`, `attachCrunchPlanFromCompletedJob`, which delegate into the questions/proposals/crunch services.
- **config/** — `/config`, `/admin/reset`: `getRuntimeConfig`, `logStartupConfig`, `handleResetData`, runtime-config normalisation/validation, `getConfiguredAiProviders`, secret masking (`maskConnectionString`, `secretState`).

Shared plumbing → **`platform/`**: store factories (`stores.ts`), provider factories + `retrievalMode` (`providers.ts`), repository/destination/flow resolution + git-checkout sync (`repositories.ts`: `findRepositoryForProposal`, `selectDestinationForProposal`, `resolveConfiguredRepositoryLocalPath`, `syncConfiguredGitCheckouts`, `selectFlow`, `defaultDestinationId`, `destinationSubpath`, etc.), source-context collection + file walking (`source-context.ts`), path utilities (`paths.ts`).

Notes:
- `platform/` functions that need `knowledgeIndex` / `embedder` take them from `AppContext` rather than reaching globals.
- The job-output type guards (`isAnswerQuestionJobOutput`, `isDraftMarkdownProposalJobOutput`, `isCrunchPlan`) become Zod schemas in their feature, used by the jobs completion dispatcher to validate watcher results — not only for request bodies.

### HTTP layer

`app.ts` builds the Hono app from `AppContext`:

- Mounts each feature router under the `/api` prefix (`app.route('/api/proposals', proposalRoutes)` etc.), replacing `apiRoutePath()`/`apiLink`. Replicate current path semantics exactly, including `OPTIONS`→204 and trailing-slash behaviour.
- **CORS**: Hono `cors()` middleware reproducing the current `*` origin and `GET,POST,DELETE,OPTIONS` methods (replaces the hand-written headers in `writeJson`).
- **Error handling**: a single `app.onError` replaces the per-`route` try/catch and the top-level `createServer` catch, returning uniform `{ error, message }`. An `HttpError` class (`http/errors.ts`) lets services throw typed failures (e.g. `proposal_not_ready` → 409) instead of ad-hoc `{ ok: false, code }` unions. Services shared with schedulers (e.g. `publishReadyProposal`) keep returning a result object; only the HTTP edge maps it to a status code.
- **Response envelopes preserved**: handlers return the exact JSON the clients expect today (`c.json({ proposal }, 201)`, `{ run }`, `{ proposals }`, `202` with `links`, etc.). Non-negotiable.

### Validation

Each feature's `schema.ts` exports Zod schemas; routes use `zValidator('json', schema)` or `zValidator('query', schema)` for `?limit=` / `?q=`. Handlers read `c.req.valid(...)`. `parseLimit`'s clamp (1–200) becomes a reusable Zod coercion. Job-output guards become Zod schemas the jobs dispatcher runs on watcher results.

### Scheduling

The two schedulers leave `main.ts` into `scheduling/`:

- `crunch-scheduler.ts`, `task-scheduler.ts` — each a small class/factory taking `AppContext`, owning its `setInterval` (with `.unref()`) and re-entrancy flag (the loose `*TickInFlight` module vars become instance fields), exposing `.start()`.
- `task-registry.ts` — the `scheduledTaskDefinitions` array (`pull-request-refresh`, `gaps-to-pull-requests`). Their handlers (`refreshPullRequests`, `processGapsIntoPullRequests`, `coveredGapSummaries`) move here but **delegate to the feature services**, so the manual publish route and the scheduled task share one code path, exactly as today.

## Migration sequencing

Every step leaves the app working and is its own commit.

0. **Scaffold.** Add `hono`, `@hono/node-server`, `@hono/zod-validator`, `zod`. Create `context.ts`, `RuntimeConfigHolder`, `BackgroundEmbedder`; move factories/helpers into `platform/`; move existing stores into `stores/`. `main.ts` still uses `node:http` but reads everything from `AppContext`. Green.
1. **Extract services, one feature per commit** (ask → knowledge → questions → gaps → proposals → crunch → jobs → config). Each commit moves logic into `features/<x>/service.ts`; the existing `main.ts` handler becomes thin and calls it. Manually verify that feature's flow before moving on. Green throughout.
2. **Extract schedulers** into `scheduling/`, delegating to the extracted services. Green.
3. **Swap the HTTP edge.** Introduce `app.ts` + per-feature `routes.ts` + Zod `schema.ts`; replace `createServer` / the regex ladder / `writeJson` / `apiRoutePath` with Hono + `cors()` + `onError` + `HttpError`. Verify **every** endpoint. The one bigger-bang step; safe because the logic underneath is already extracted and unchanged.
4. **Test the new layer.** Unit-test the extracted services (pass a context built with in-memory stores) and add a thin smoke test per router.

## Testing & verification

- **New unit tests** (step 4): one suite per service, exercised against an `AppContext` wired to in-memory stores — covering merge cascade, gap→PR drafting/publish, crunch planning, ask direct/queue, and the jobs completion dispatcher.
- **Manual flow-verification checklist** (run after each phase, compensating for no upfront characterization tests), against the in-memory backend:
  - ask — direct and queue modes
  - index a repository, then search and read `/knowledge/stats`
  - submit feedback → manual gap → gap candidate appears
  - draft a proposal from one and from clustered gaps
  - publish a ready proposal → branch pushed / PR raised
  - merge cascade — mark merged → gaps resolved + destination re-indexed
  - crunch run (manual trigger) → publish the run
  - scheduled-task manual run for both registered tasks
- Existing store/clustering tests continue to backstop the persistence layer.
- `npm run build`, `npm run test`, `npm run typecheck` green at every commit.

## Risks & mitigations

- **Response-envelope drift breaking hand-coded web/MCP/watcher clients.** Mitigation: preserve exact JSON shapes; the verification checklist exercises each consumer-facing route.
- **No end-to-end safety net during extraction** (chosen trade-off). Mitigation: always-green incremental sequence (one feature per commit) + manual verification per phase; the riskiest change (HTTP swap) lands last, on top of already-extracted, unchanged logic.
- **Subtle Hono routing differences** (`/api` prefix, trailing slashes, `OPTIONS`/204). Mitigation: explicitly replicated and verified in step 3.
- **Hidden coupling via module globals surfacing during extraction.** Mitigation: the composition root makes every dependency explicit; anything that resists injection is a finding to surface, not paper over.

## Future work (separate specs, enabled by this one)

- `@magpie/contracts` wire-types package (lift the Zod schemas; adopt in web/mcp/watcher).
- `@magpie/http-client` to de-duplicate the triplicated fetch wrappers.
- Web `page.tsx` decomposition.
- Store-layer: shared pool + `withTransaction` helper + de-duplicated in-memory/Postgres logic.
- Move cron parsing and the mock crunch-plan builder out of `@magpie/core`.
