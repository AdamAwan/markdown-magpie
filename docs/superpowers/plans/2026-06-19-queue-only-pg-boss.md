# Queue-Only pg-boss Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Direct AI execution, the custom AI queue, and both API timer schedulers with one Postgres-backed `pg-boss` job system executed by capability-filtered multipurpose watchers.

**Architecture:** `@magpie/jobs` owns provider-neutral job contracts, Zod schemas, capabilities, and per-type policies. The API owns `pg-boss` behind a `JobBroker`, exposes `/api/jobs`, validates/idempotently applies completions, and reconciles product schedule settings. Watchers retain HTTP-only access, advertise capabilities, heartbeat while executing, and run hosted APIs, agent CLIs, GitHub checks, and orchestration tasks.

**Tech Stack:** TypeScript 6 (NodeNext, strict), Node 22.12+, npm workspaces, `pg-boss` 12.18, PostgreSQL 16/pgvector, Hono, Zod, Next.js 16, `node:test` + `tsx`.

---

## Execution Progress (resume marker)

_Updated 2026-06-21. Checkout: repository root. Branch: `feat/queue-only-pg-boss` (pushed)._

- **Task 1 — complete.** Durable job catalog in `@magpie/jobs` (commits `501bd96`..`bbfecc5`). 7/7 jobs tests pass.
- **Task 2 — complete.** `JobBroker` boundary + test-only `FakeJobBroker`, `ctx.jobs` wired, `ctx.stores.aiJobs` removed, jobs feature migrated to `JobView` (commits `17c69a1`..`88c6db7`). Reviewed clean after fixing 2 Important findings (dropped `as never`/assertion casts). 87/87 API tests, root typecheck clean.
  - Deferred Minor findings for the final whole-branch review: `fake-broker.ts` heartbeat doesn't guard illegal/terminal states; fake records no claimant (`void workerName`).
  - Transitional state to undo later: `createAppContext()` uses a `FakeJobBroker` placeholder (`TODO(Task 3)`) — Task 3 replaces it with the real `PgBossJobBroker`; a `"mock"` → `"openai-compatible"` provider mapping in ask/proposals/crunch services is cleaned up in Task 11.
- **Task 3 — complete.** `PgBossJobBroker`, public queue/schedule APIs, fair capability claims, durable lifecycle projection, mandatory Postgres composition, and graceful broker startup/shutdown (commit `ee9ccc8`). Real Postgres gate: 174/174 API tests; root typecheck and focused lint clean.
- **Task 4 — complete.** `/api/jobs` now exposes capability-filtered claim, heartbeat, bounded wait, structured failure, cancel/retry, schedules, catalog-validated completion, filtered pagination, and non-mutating redacted projections (commit `eb6af52`). 38/38 API test files pass; root typecheck and focused lint clean.
- **Task 5 — complete.** Repeated answer, proposal, and crunch completion now converges by job ID; proposal uniqueness is enforced by migration `0022`, queue output records `{ result, executor }`, and retryable crunch failures leave runs active (commit `b63d5cd`). 174 tests pass, migration and root typecheck clean; real Postgres proposal-store suite 6/6.
- **Task 6 — COMPLETE (request-path scope).** Ask, proposal drafting/publication, and crunch planning/publication are enqueue-only with no API-side generative or Git execution. Gap clustering (6D) was obsolete and skipped; chat-provider removal (6E) reassigned to Task 8 (only remaining chat callers are background scheduled tasks). Decomposed into sub-tasks 6A–6E; see the design amendment at the head of Task 6 (routing+retrieval moved to the watcher with a new `POST /api/retrieve` callback).
  - **6A — complete** (commits `f599658`, `e8cf4b8`). `answer_question` contract changed (input `context`→`flows`, output gains `flowId`); `ask()` is enqueue-only; new pure `POST /api/retrieve`; completion records `flowId`+`retrievedSectionIds`. Spec review ✅; code-quality review fixups applied (unknown `flowId`→422; inert-persona note). 180/180 API tests, jobs+prompts green, typecheck clean. Minimal transitional `TODO(Task 7)` stubs left in `apps/watcher/src/{job-prompts,main}.ts` and `packages/prompts/src/build.ts` (watcher mock answerer emits no citations until Task 7 wires the retrieve callback).
  - **Deferred to Task 11:** `ask()` passes the configured provider through unmapped, so `aiProvider: "mock"` now fails `answer_question` schema validation (mock isn't a job provider). Resolved when Task 11 removes `mock` and makes a real provider mandatory. Do NOT re-add the `mock→openai-compatible` mapping.
  - **Deferred to Task 10 — RESOLVED in Task 10.** `apps/web/src/components/ConsoleProvider.tsx` no longer reads `answer.mode`/`answer.result`. The refresh effect keeps `answer.job` fresh from the `/jobs` list; the answer lands on the question log (rendered by `AskPanel`); the ask handler `waitForJob`s the queued `answer_question` job. See the Task 10 entry below.
  - **6B — complete** (commits `3a242f2`, `3d64861`). Proposal drafting enqueue-only; publication converted to a `publish_proposal` job with fail-fast 404/409 pre-flight; `publish_proposal` completion handler records publication idempotently; new `GET /api/proposals/:id/execution-context` (no credentials). Git execution removed from the API; pure branch-name/PR-body helpers kept exported for Task 7. Spec review ✅; code-quality ✅ (Approve) with three minor fixups applied. Necessary behaviour-preserving cascades: `gaps/service.ts` (dead direct-branch removed), `gap-reconciler.ts` `defaultPublish` (sync→enqueue), web `ConsoleProvider.tsx` publish handler (reads `{ job }`). 188/188 API tests, typecheck clean.
  - **6C — complete** (commit `32c9dda` + fixups). Crunch planning enqueue-only (direct/`ctx.background` path deleted, `ctx.background` itself kept); publication converted to a `publish_crunch` job with fail-fast 404/409 pre-flight (incl. crunch-specific `crunch_run_empty_plan`); `publish_crunch` completion handler records publication idempotently (no PR for crunch); new `GET /api/crunch/runs/:id/execution-context` (no credentials). Spec review ✅; code-quality ✅ (Approve) with the empty-plan no-enqueue test added + stale-comment fixups. Minimal web `ConsoleProvider.tsx` publish cascade. 198/198 API tests, typecheck clean.
  - **6D (gaps clustering) — SKIPPED (scope correction).** The plan's "remove synchronous AI clustering from GET paths / `POST /api/gaps/clusters`" targets an architecture that no longer exists: the gaps feature (`listCandidates`/`listClusters`) is pure reads, and clustering is maintained by the background `gap-reconciler`. Nothing calls a gaps clustering endpoint today; Task 8's `process_gaps_to_pull_requests` introduces `cluster_gap_candidates` where it is actually used. No endpoint added now.
  - **6E (remove `ctx.providers.chat`) — DEFERRED to Task 8.** After ask/proposals/crunch, the only remaining API generative-chat callers are **background scheduled tasks**, not request paths: `gap-reconciler` `proposeReshape`/`criticConfirm` (registered at `scheduling/task-registry.ts:40`) and `source-sync` `generateSyncPlan` (`task-registry.ts:50`), both run by `TaskScheduler`. They leave the API process when scheduled work moves to watchers in **Task 8** (which deletes `task-scheduler.ts`/`crunch-scheduler.ts`). `ctx.providers.chat` is removed at the end of Task 8, once these are converted. (Confirmed with Adam 2026-06-21: these are the "long-lived work" already on the path out of the API.)

**Task 6 verdict: COMPLETE for its request-path scope (ask, proposals, crunch all enqueue-only).** Gap clustering was obsolete (skipped); chat-provider removal reassigned to Task 8.

- **Task 7 — complete** (commits `ada3205`..`f687399`). Watcher rewritten to the capability/runner model: `capabilities.ts` (env→capabilities, no `mock`), `http-client.ts` (`/api/jobs` claim/heartbeat/complete/fail + `/api/retrieve` + execution-context GETs, sends `executor`), `worker-loop.ts` (claim→dispatch→terminal, heartbeat at half catalog interval, `cancelled`-heartbeat aborts runner via `AbortSignal`, shutdown aborts in-flight), and runners (`chat` OpenAI+Azure with route→retrieve→answer and code-derived citations; `cli` SIGTERM→grace→SIGKILL; `publication` github-gated `publish_proposal`/`publish_crunch` via `@magpie/git`). `main.ts` reduced to composition (541→~75 lines); inline mock runner + provider switch deleted. Cross-package: `AbortSignal` threaded through `@magpie/core` `ChatRequest` + `@magpie/retrieval` (`AbortSignal.any`); `/api/retrieve` `RetrievedSection` extended with `documentId`+`anchor` (required by the citation schema). Spec review ✅; code-quality ✅ (Approve-with-fixes) — applied: single capability source via `deriveCapabilities` (removed `runners.map` divergence), faithful `normalizeRelativePath`, symmetric `publishProposalOutputSchema.parse`. 33/33 watcher tests, root typecheck clean.
  - **Transitional:** `maintenance` is advertised (per Step-1 contract) but has no runner until **Task 8**; nothing enqueues maintenance jobs before then, and the worker loop fails an unsupported-type job safely. `TODO(Task 8)` left in `runners/index.ts`.
  - **Note:** branch-name/PR-body/changeset helpers were reimplemented locally in `runners/publication.ts` (watcher can't import sibling `apps/api`), matched byte-for-byte to the API. The API's now-orphaned copies (`createProposalBranchName`, `crunchBranchName`, `buildPullRequestBody`) were already knip-dead at the branch baseline (orphaned by Task 6). A future cleanup could move the pure helpers into a shared package.

- **Task 8 — IN PROGRESS (sub-tasks 8A–8C complete; 8D–8F remain).** See the design amendment at the head of Task 8 (3 decisions + Option A + the 8A–8F breakdown). _Updated 2026-06-22._
  - **8A — complete** (commit `8d1ab8f`). Four new job contracts + Zod schemas + catalog policies + capability routing in `@magpie/jobs`: `reconcile_gap_clusters` (AI), `sync_source_changes_generate_plan` (AI, reuses core `SourceChangeSyncJobInput`/`CrunchPlan` via `ProviderInput<T>`), `source_change_sync` (maintenance), `publish_source_sync` (github, mirrors `publish_crunch`). `queueNamesForCapabilities(["github"])` now ends `…, publish_source_sync`; `["maintenance"]` ends `…, source_change_sync`. Combined spec+quality review ✅ (no issues). 14/14 jobs tests.
  - **8B — complete** (commit `4dd60aa`). `ScheduleReconciler` (crunch→`trigger_scheduled_crunch` key `flow:<id|default>`; scheduled tasks→their job types key `task:<baseKey>::<flow>`), wired at startup (after `ctx.jobs.start()`) + after crunch/scheduled-task/config settings mutations; idempotent. Deleted `task-scheduler.ts`/`crunch-scheduler.ts`/`interval-scheduler.ts` and their `main.ts` starts. Removed `lastRunAt`/`nextRunAt`/`runningSince` + `touchSchedule`/`tryAcquireRun`/`releaseRun`/`runLockStaleMs` from crunch + scheduled-task stores (columns dropped later in Task 12; stores just stop reading/writing). Next-run now sourced from `ctx.jobs.listSchedules()` joined by stable key. Combined review ✅ (no Critical/Important; 2 trivial Minors left). 199 API tests pass. **Carry-forward for 8E:** manual "Run now" no longer returns 409 `already_running` (in-store run-lock removed); overlap protection must be restored via pg-boss singleton semantics in 8E.
  - **8C — complete** (commit `2458919`). Gap-cluster reshape moved off `ctx.providers.chat`: watcher `chat` runner gains a bespoke `reconcile_gap_clusters` propose→critic flow (confirmed flags derived from the critic, never trusted from propose; `AbortSignal` threaded). `gap-reconciler.ts` `proposeReshape`/`criticConfirm`/`parseReshape` deleted; `reconcileClusters` now enqueues `reconcile_gap_clusters` and bounded-waits via new reusable `runJobToCompletion(ctx, type, input, {deadlineMs})` (default = job `expireInSeconds`, env `JOB_RUN_TO_COMPLETION_TIMEOUT_MS`); reshape is best-effort (timeout/failure/malformed ⇒ skip, no throw). New `POST /api/gaps/reconcile {flowId?}` (scope `manage:jobs`). New watcher `runners/maintenance.ts` `MaintenanceRunner` (`maintenance` capability, supports `process_gaps_to_pull_requests`) POSTs the reconcile endpoint — resolves Task 7's `TODO(Task 8)`. No completion handler needed (type-guarded dispatch early-returns). Docs: `architecture.md` updated. Spec review ✅; code-quality ✅ (Approve) — follow-ups applied (commit `364bb4d`): added a broker-throws-mid-poll skip test (verified it fails without the try/catch), TODO on the maintenance runner's hardcoded `{drafted:0,published:0}` under-report. 204 API + 39 watcher tests pass; typecheck clean.
  - **8D — complete** (commits `855598c` CP1 + `5daf629` CP2). Source-sync moved off the API chat provider and off in-API git writes (Option A). Gather (checkout+diff+candidate retrieval) stays in the API; `generateSyncPlan` now enqueues `sync_source_changes_generate_plan` and bounded-waits via `runJobToCompletion` (mock special-case deleted); the constrained changeset is persisted on the run (core field + both stores + migration `0023_source_sync_changeset.sql`, **written but UNAPPLIED — no local Postgres; apply on a real stack / folds into Task 12 migration run**). New thin `POST /api/source-sync/run {flowId?}` (scope `manage:jobs`) → `triggerSourceSyncRun`; `source_change_sync` maintenance runner POSTs it; its output schema changed to `{ runIds: string[] }` (0..N runs/git-source). Publish is enqueue-only: `publishRun`→`publish_source_sync {runId}` fire-and-forget after repo pre-flight; new `GET /api/source-sync/runs/:id/execution-context` (scope `manage:knowledge`, no provider creds); watcher github-gated `publish_source_sync` runner (branch `magpie/source-sync-<id8>`) in `publication.ts`; idempotent `recordSourceSyncPublicationFromCompletedJob` dispatched in `completeJob` (mirrors `publish_crunch`). Recovered after the original implementer hit a transient 529 mid-CP2 (CP2 finished + verified by a follow-up agent). Combined review ✅ (Approve; 2 Minors = sibling-consistent AbortSignal/no-malformed-test nits, not fixed). 214 API + 43 watcher + 15 jobs tests pass; typecheck clean. `source-sync/service.ts` no longer references `ctx.providers.chat`.
  - **8E — complete** (commits `be541d9` A+B + `dd6b3e2` C). Last two scheduled runners + manual-run conversion. (A) `MaintenanceRunner` gains `trigger_scheduled_crunch` (maintenance) → POSTs `/api/crunch/run {trigger:"scheduled", flowId?}`, returns `{runId, jobId}`; new `WatcherApi.triggerScheduledCrunch`. No completion handler needed (type-guarded dispatch passes unknown types through as no-ops). (B) New github-gated `RefreshPullRequestsRunner` (`refresh_pull_requests` is a **github** job, not maintenance — it holds the token): fetches `/api/proposals?status=pr-opened` (new `WatcherApi.listOpenPullRequests`), polls each via `@magpie/git` `fetchPullRequestStatus`, honours `AbortSignal` between requests, returns `{results:[{proposalId,state,merged}]}`. API `completeJob` applies merged→cascade+freeze / closed→rejected+freeze via a **shared** `applyPullRequestTransition` extracted from `gap-reconciler.refreshOpenPullRequests` (no duplication); idempotent by guarding on the proposal's current `pr-opened` status (re-completing converges, no second cascade). (C) `POST /api/scheduled-tasks/:key/run` now enqueues the task's `jobType`/`input` (202 + job link) instead of running in-process; overlap protection restored **broker-agnostically** (pg-boss `create` exposes no singleton key) — scan `ctx.jobs.list` for an in-flight (`created`/`active`/`retry`/`blocked`) job of the same type+flowId, return 409 `already_running`. Dropped the now-dead `run` handler from `ScheduledTaskDefinition`/templates. **Snapshot reconciliation (DONE_WITH_CONCERNS):** `refresh_pull_requests` replaces the API-side PR polling, not the snapshot store. `snapshotService.refreshSnapshot` is left intact and tested but now has **no API caller** (its only one was the removed in-process `snapshot-refresh` run handler), so nothing repopulates the snapshot; the reconciler's `refreshOpenPullRequests` degrades to its live-poll fallback (returns undefined without a token, harmless since transitions are now applied eagerly by the job) and the drafter's `collectOpenPullRequestContext` returns `[]`. Not deleted destructively — left for a follow-up to either wire `refresh_pull_requests`' results into the snapshot or retire the snapshot store. Combined review ✅ (Approve) — confirmed the `applyPullRequestTransition` extraction is behavior-preserving and the snapshot degradation is safe to defer; 2 documented Minors (non-atomic check-then-enqueue race on the manual button; one redundant store read). 220 API + 50 watcher + 15 jobs tests pass; typecheck clean.

  - **8F — complete** (commit `4e11733`, −80/+13). Removed the API's generative chat provider entirely (deferred 6E): dropped `chat` from `AppContext.providers` type + the `createAppContext` literal + `test-support/context.ts` (`stubChat`), deleted `createConfiguredChatProvider` and the now-unused `createChatProvider` import from `platform/providers.ts`, and removed 5 dead `ctx.providers.chat = …` test stubs (incl. their `as never` casts) — the two "no model call" assertions became the equivalent "no `reconcile_gap_clusters` job enqueued" invariant. Embedding provider untouched + still wired. `rg "ctx.providers.chat|createConfiguredChatProvider" apps/api/src` → nothing. Review ✅ (Approve, no issues). 220 API tests pass; typecheck clean. (`MockChatProvider`/`mock` plumbing lives in `@magpie/retrieval` + `getConfiguredAiProviders` still lists `mock` — left for Task 11.)

**Task 8 — COMPLETE (8A–8F all done and reviewed).** The API no longer runs any generative work: ask/proposals/crunch (Task 6), gap reshape + scheduled gaps→PR (8C), source-sync (8D), PR-refresh + scheduled crunch + manual runs (8E) all go through pg-boss jobs executed by capability-filtered watchers; both in-API cron timers are gone (8B); `ctx.providers.chat` is removed (8F). Open carry-forwards: apply migration `0023` on a real Postgres (Task 12/14); decide snapshot store fate (Task 11/12); remove `mock` provider/Direct (Task 11).

- **Task 9 — complete** (commits `1ccb1b5` + `bf6ff8e`). MCP moved to create→wait→poll. Change landed in `apps/mcp/src/kb-client.ts` (the shared client both transports use; `main.ts` needed no edit). `askQuestion` reads `links.wait`/`links.job` from the 202 `/api/ask` response, calls `GET /api/jobs/:id/wait` (200 terminal / 202 non-terminal), falls back to polling `GET /api/jobs/:id` until terminal or `ANSWER_TIMEOUT_MS`; unwraps the terminal `{ result, executor }` envelope (answer fields from `result`). States mapped: `completed`→return; `failed`/`cancelled`→throw with job id+state (no payload leak); `created|retry|active|blocked`→poll; deadline→timeout error with id+state. Direct/inline (`ask.result`, `waitForQueuedAnswer`) removed; `docs/mcp.md` rewritten. Review ✅ (Approve-with-fixes); the one Low finding (no tests for the new flow) was closed by `bf6ff8e` (7 new hermetic fetch-stubbed tests covering happy/202-poll/failed/cancelled/timeout/missing-links). 33 MCP tests pass; build + typecheck clean.
  - **Carry-forward to Task 12:** the `0023` migration must be applied on a real Postgres (none available in this dev env); Task 12's `db:migrate` run / final E2E (Task 14) covers it.
  - **Carry-forward from 8E:** the snapshot store (`refreshSnapshot` / `FileSnapshotStore`) has no writer now that PR polling is a watcher job — decide whether `refresh_pull_requests` should persist its `{results}` into the snapshot (so the reconciler/drafter keep their cache) or whether the snapshot mechanism is retired.

---

## Global Constraints

- Work on `feat/queue-only-pg-boss`; do not merge until API, watcher, web, MCP, Compose, migrations, and docs are compatible.
- The approved design is `docs/superpowers/specs/2026-06-19-queue-only-pg-boss-design.md`.
- Never query or mutate private `pg-boss` tables. Use `send`, `fetch`, `findJobs`, `touch`, `complete`, `fail`, `cancel`, `retry`, queue statistics, and schedule APIs.
- `findJobs()` is queue-scoped and has no pagination options. The broker may combine registered queues, sort, filter, and slice for the first operations view; the 30-day retention bounds storage. Do not claim database-level pagination until the library provides it.
- AI queue names are partitioned by provider (for example `answer_question__codex`). Queue claims are FIFO within a concrete queue and fairly rotated across queues enabled by watcher capabilities. Do not promise global FIFO across types/providers.
- The API never calls a generative chat provider after Task 7.
- Runtime Postgres is mandatory. In-memory job infrastructure is test-only and injected explicitly.
- Remove the runtime mock chat/embedding/job provider. Tests use fakes that cannot be selected from environment configuration.
- Completion side effects must be idempotent by job ID before the queue job is acknowledged.
- Watcher authentication and persistent worker registration are explicitly out of scope.
- Root `npm run typecheck` is the authoritative type gate because per-package checks that follow workspace path aliases can hit the repository's known `rootDir` issue.

## Target File Structure

```text
packages/jobs/src/
  types.ts                 # Job/provider/capability/public projection contracts
  schemas.ts               # Zod input/output/error schemas for every job type
  catalog.ts               # Queue names, capability resolver, retry/lease/retention policy
  catalog.test.ts
  index.ts                 # Public exports

apps/api/src/jobs/
  broker.ts                # JobBroker interface and shared filters
  pg-boss-broker.ts        # Only pg-boss adapter
  pg-boss-broker.integration.test.ts
  fake-broker.ts           # Test-only deterministic broker
  schedule-reconciler.ts   # Product settings -> pg-boss schedules
  schedule-reconciler.test.ts

apps/api/src/features/jobs/
  routes.ts                # /api/jobs lifecycle and schedules routes
  schema.ts                # Request/query schemas
  service.ts               # Validation, wait, completion dispatch
  service.test.ts

apps/watcher/src/
  main.ts                  # Composition and shutdown only
  capabilities.ts          # Environment -> accepted job types
  http-client.ts           # API claim/heartbeat/complete/fail/wait client
  worker-loop.ts           # Poll, heartbeat, cancellation, dispatch
  runners/
    types.ts
    chat.ts                # OpenAI-compatible and Azure OpenAI
    cli.ts                 # Codex and Claude child processes
    maintenance.ts         # PR refresh and API orchestration jobs
    index.ts
  *.test.ts
```

Existing feature services remain in their current vertical slices. Do not move unrelated domain code.

### Task 1: Define shared job contracts and policies

**Files:**
- Modify: `packages/jobs/package.json`
- Create: `packages/jobs/src/types.ts`
- Create: `packages/jobs/src/schemas.ts`
- Create: `packages/jobs/src/catalog.ts`
- Create: `packages/jobs/src/catalog.test.ts`
- Modify: `packages/jobs/src/index.ts`
- Modify: `package-lock.json`

- [x] **Step 1: Add the catalog tests first**

```ts
// packages/jobs/src/catalog.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { JOB_TYPES, jobDefinition, queueNameForJob, queueNamesForCapabilities } from "./index.js";

test("every job type has schemas and a durable execution policy", () => {
  assert.equal(new Set(JOB_TYPES).size, JOB_TYPES.length);
  for (const type of JOB_TYPES) {
    const definition = jobDefinition(type);
    assert.equal(definition.type, type);
    assert.ok(definition.policy.retryLimit >= 0);
    assert.ok(definition.policy.heartbeatSeconds >= 10);
    assert.ok(definition.policy.expireInSeconds > definition.policy.heartbeatSeconds);
    assert.equal(definition.policy.deleteAfterSeconds, 30 * 24 * 60 * 60);
  }
});

test("capabilities select only compatible provider queues", () => {
  const codexQueues = queueNamesForCapabilities(new Set(["codex"]));
  assert.ok(codexQueues.includes("answer_question__codex"));
  assert.ok(!codexQueues.includes("answer_question__openai_compatible"));
  assert.equal(queueNameForJob("answer_question", { provider: "codex" }), "answer_question__codex");
  assert.deepEqual(queueNamesForCapabilities(new Set(["github"])), [
    "refresh_pull_requests", "publish_proposal", "publish_crunch"
  ]);
});
```

- [x] **Step 2: Run the test to verify the missing exports fail**

Run: `npm test -w @magpie/jobs`

Expected: FAIL because `JOB_TYPES`, `jobDefinition`, `queueNameForJob`, and `queueNamesForCapabilities` do not exist.

- [x] **Step 3: Add dependencies and test script**

Add `@magpie/core`, `zod`, `tsx`, and `@types/node` using the same workspace/file conventions as `@magpie/prompts`, and add:

```json
"test": "node --import tsx --test \"src/**/*.test.ts\""
```

Run: `npm install`

Use `"pg-boss": "^12.18.2"` later in the API, not in this provider-neutral package.

- [x] **Step 4: Define the stable contracts**

```ts
// packages/jobs/src/types.ts
export const JOB_TYPES = [
  "answer_question", "summarize_gap", "draft_markdown_proposal",
  "detect_contradiction", "suggest_consolidation", "crunch_knowledge_base",
  "cluster_gap_candidates", "refresh_pull_requests",
  "process_gaps_to_pull_requests", "trigger_scheduled_crunch",
  "publish_proposal", "publish_crunch"
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const AI_PROVIDERS = ["openai-compatible", "azure-openai", "codex", "claude"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];
export type JobCapability = AiProviderName | "github" | "maintenance";
export type JobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed" | "blocked";

export interface JobError {
  code: string;
  message: string;
  category: "provider" | "validation" | "configuration" | "timeout" | "external" | "internal";
  provider?: string;
  details?: Record<string, string | number | boolean | null>;
  executor?: string;
}

export interface JobView<TInput = unknown, TOutput = unknown> {
  id: string;
  type: JobType;
  queueName: string;
  deadLetter: boolean;
  state: JobState;
  input: TInput;
  output?: TOutput;
  error?: JobError;
  retryCount: number;
  retryLimit: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  retryAt?: string;
  heartbeatAt?: string;
  heartbeatSeconds?: number;
  expireInSeconds: number;
}

export interface JobPolicy {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: true;
  retryDelayMax: number;
  heartbeatSeconds: number;
  expireInSeconds: number;
  retentionSeconds: number;
  deleteAfterSeconds: number;
  deadLetter?: string;
}
```

- [x] **Step 5: Define schemas and catalog entries**

In `schemas.ts`, define `jobErrorSchema` and one input/output Zod schema per `JOB_TYPES` entry. Reuse `@magpie/core` domain shapes through `satisfies z.ZodType<...>` where practical. Include these new shapes explicitly:

```ts
export const clusterGapCandidatesInputSchema = z.object({
  candidates: z.array(z.object({ summary: z.string(), questionIds: z.array(z.string()) })),
  provider: z.enum(AI_PROVIDERS)
});
export const clusterGapCandidatesOutputSchema = z.object({
  clusters: z.array(z.object({ label: z.string(), summaries: z.array(z.string()).min(1) }))
});
export const refreshPullRequestsInputSchema = z.object({});
export const refreshPullRequestsOutputSchema = z.object({
  results: z.array(z.object({
    proposalId: z.string(), state: z.enum(["open", "closed"]), merged: z.boolean()
  }))
});
export const processGapsInputSchema = z.object({});
export const processGapsOutputSchema = z.object({ drafted: z.number().int(), published: z.number().int() });
export const scheduledCrunchInputSchema = z.object({ flowId: z.string().optional() });
export const scheduledCrunchOutputSchema = z.object({ runId: z.string(), jobId: z.string() });
export const publishProposalInputSchema = z.object({ proposalId: z.string() });
export const publishProposalOutputSchema = z.object({
  proposalId: z.string(), branchName: z.string(), commitSha: z.string(),
  remoteUrl: z.string().optional(), pullRequestUrl: z.string().optional(),
  publishedAt: z.string()
});
export const publishCrunchInputSchema = z.object({ runId: z.string() });
export const publishCrunchOutputSchema = z.object({
  runId: z.string(), branchName: z.string(), commitSha: z.string(),
  remoteUrl: z.string().optional(), publishedAt: z.string()
});
```

In `catalog.ts`, create one immutable `JobDefinition` for every type. AI definitions resolve their capability from `input.provider` and `queueNameForJob()` produces a provider-partitioned queue name; maintenance definitions use their type as queue name. `allQueueDefinitions()` expands every AI type across all four providers for startup provisioning. Use a 30-day `deleteAfterSeconds`, 14-day queued retention, heartbeat 60 seconds, and explicit expirations: 5 minutes for answer/cluster/PR refresh, 15 minutes for drafting, 60 minutes for crunch and orchestration. Set three retries with exponential backoff for provider work and two for maintenance. Provision one non-consumed dead-letter queue per concrete work queue and set `deadLetter` to that queue name; include dead-letter queues in operations listing but never in watcher claim expansion.

- [x] **Step 6: Export and verify**

Export contracts, schemas, catalog, `isJobType`, `isAiProviderName`, `jobDefinition`, `queueNameForJob`, `allQueueDefinitions`, and `queueNamesForCapabilities` from `index.ts`.

Run: `npm test -w @magpie/jobs && npm run build -w @magpie/jobs && npm run typecheck`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add package-lock.json packages/jobs
git commit -m "feat(jobs): define durable job catalog"
```

### Task 2: Introduce the broker boundary and test fake

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/jobs/broker.ts`
- Create: `apps/api/src/jobs/fake-broker.ts`
- Create: `apps/api/src/jobs/fake-broker.test.ts`
- Modify: `apps/api/src/context.ts`
- Modify: `apps/api/src/test-support/context.ts`
- Modify: `package-lock.json`

- [x] **Step 1: Test the fake lifecycle**

```ts
test("fake broker supports create, claim, heartbeat, complete, cancel, and retry", async () => {
  const broker = new FakeJobBroker();
  const created = await broker.create("answer_question", validAnswerInput);
  const claimed = await broker.claim("worker-1", ["codex"]);
  assert.equal(claimed?.id, created.id);
  assert.equal((await broker.heartbeat(created.id)).state, "active");
  await broker.fail(created.id, testError);
  assert.equal((await broker.get(created.id))?.state, "retry");
  await broker.cancel(created.id);
  assert.equal((await broker.get(created.id))?.state, "cancelled");
});
```

- [x] **Step 2: Run and observe the missing fake**

Run: `npm test -w @magpie/api -- --test-name-pattern="fake broker"`

Expected: FAIL because `FakeJobBroker` is missing.

- [x] **Step 3: Define the application-owned interface**

Add `@magpie/jobs` as an API workspace dependency and run `npm install` before importing these contracts.

```ts
export interface JobBroker {
  start(): Promise<void>;
  stop(): Promise<void>;
  create(type: JobType, input: unknown): Promise<JobView>;
  claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined>;
  heartbeat(id: string): Promise<JobView>;
  complete(id: string, output: unknown): Promise<JobView>;
  fail(id: string, error: JobError): Promise<JobView>;
  cancel(id: string): Promise<JobView>;
  retry(id: string): Promise<JobView>;
  get(id: string): Promise<JobView | undefined>;
  list(filters: JobListFilters): Promise<{ jobs: JobView[]; total: number }>;
  reconcileSchedules(schedules: DesiredSchedule[]): Promise<void>;
  listSchedules(): Promise<ScheduleView[]>;
  reset(): Promise<void>;
}
```

`JobListFilters` contains optional `type`, `state`, `createdAfter`, `limit` (1-200), and `offset` (>=0). `DesiredSchedule` contains `type`, `key`, `cron`, `input`, and `enabled`.

- [x] **Step 4: Implement `FakeJobBroker`**

Use an insertion-ordered `Map`, catalog validation, deterministic state transitions, and fake schedules. Keep it test-only; do not read environment variables. Add `jobs: JobBroker` to `AppContext`, remove `stores.aiJobs`, and make `makeTestContext()` accept `jobs = new FakeJobBroker()`.

- [x] **Step 5: Run API tests and root types**

Run: `npm test -w @magpie/api && npm run typecheck`

Expected: existing job service compile failures identify call sites still using `ctx.stores.aiJobs`; update only their dependency reference to `ctx.jobs` without changing behavior yet.

- [x] **Step 6: Commit**

```bash
git add apps/api/package.json apps/api/src/jobs apps/api/src/context.ts apps/api/src/test-support/context.ts apps/api/src/features/jobs package-lock.json
git commit -m "refactor(api): introduce job broker boundary"
```

### Task 3: Implement the pg-boss broker

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/jobs/pg-boss-broker.ts`
- Create: `apps/api/src/jobs/pg-boss-broker.integration.test.ts`
- Modify: `apps/api/src/context.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add an opt-in Postgres integration script and tests**

Add root script:

```json
"test:integration": "RUN_PG_INTEGRATION=1 npm test -w @magpie/api -- --test-name-pattern=pg-boss"
```

The integration suite must skip unless `RUN_PG_INTEGRATION=1`, use `DATABASE_URL`, and use a unique schema such as `pgboss_test_${process.pid}`. Cover create/get, provider isolation (Codex cannot claim OpenAI work), same-queue FIFO claim, fair cross-queue claims, touch, failure-to-retry, complete output, cancel, manual retry, list filters, reset, and schedule reconciliation.

- [ ] **Step 2: Verify the suite fails before the adapter exists**

Run: `RUN_PG_INTEGRATION=1 npm test -w @magpie/api -- --test-name-pattern=pg-boss`

Expected: FAIL because `PgBossJobBroker` is missing. Before running it, start local Postgres with `docker compose up -d postgres`.

- [ ] **Step 3: Install and implement `pg-boss`**

Run: `npm install pg-boss@^12.18.2 cron-parser@^5.5.0 -w @magpie/api`

Construct `PgBoss` with `connectionString`, `schema`, `persistWarnings: true`, and normal supervision/scheduling enabled. On `start()` create or update every catalog queue from its policy. Map metadata with one pure `toJobView()` function.

Store a small envelope in `pg-boss` data: `{ type, input }`. Implement claim by expanding the caller's validated capabilities to concrete queue names, rotating an in-memory cursor over them, and calling:

```ts
const jobs = await this.boss.fetch(queueName, { batchSize: 1, includeMetadata: true, orderByCreatedOn: true });
```

Resolve ID-only operations by probing provisioned queue names with `findJobs(queueName, { id })`. Use `findJobs(queueName)` for the bounded first-version operations list, combine results, apply filters, sort newest-first, then slice `offset..offset+limit`.

- [ ] **Step 4: Make runtime Postgres mandatory and manage lifecycle**

`createAppContext()` must call `requireDatabaseUrl()` unconditionally for jobs and construct `PgBossJobBroker`. `main.ts` calls `ctx.jobs.start()` before `bootstrap()`/serve, installs SIGINT/SIGTERM handlers that await `ctx.jobs.stop()`, and fails startup non-zero on broker errors.

Update root `engines.node` to `>=22.12`.

- [ ] **Step 5: Run integration and unit gates**

Run: `RUN_PG_INTEGRATION=1 npm test -w @magpie/api -- --test-name-pattern=pg-boss`

Expected: PASS.

Run: `npm test -w @magpie/api && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json apps/api/package.json apps/api/src/context.ts apps/api/src/main.ts apps/api/src/jobs
git commit -m "feat(api): back jobs with pg-boss"
```

### Task 4: Replace the job HTTP contract

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/features/jobs/schema.ts`
- Modify: `apps/api/src/features/jobs/service.ts`
- Modify: `apps/api/src/features/jobs/routes.ts`
- Modify: `apps/api/src/features/jobs/service.test.ts`

- [ ] **Step 1: Write lifecycle service tests**

Cover: schema-valid create; filters; capability validation and provider-isolated claim; heartbeat active/cancelled response; 25-second wait returning terminal or current `202`; cancel; retry only failed; completion validation; completion rejected after cancellation; failure using `JobError`; and display redaction of fields named `apiKey`, `token`, `authorization`, or `password` at any nesting depth.

Use a 10ms injected wait cap in tests:

```ts
const result = await waitForJob(ctx, job.id, { timeoutMs: 10, pollMs: 1 });
assert.equal(result.terminal, false);
assert.equal(result.job.state, "created");
```

- [ ] **Step 2: Run tests to capture old-contract failures**

Run: `npm test -w @magpie/api -- --test-name-pattern="job"`

Expected: FAIL because wait, heartbeat, cancel, retry, filters, and `JobError` requests are absent.

- [ ] **Step 3: Implement schemas and services**

Define Zod schemas for list queries, capability-based claim, complete, fail, and bounded wait configuration. `completeJob()` must parse output through `jobDefinition(job.type).outputSchema` before invoking completion dispatch. If parsing or dispatch throws, call `ctx.jobs.fail()` with a safe validation/internal error before rethrowing the HTTP failure.

Add separate projections: claim returns the full schema-validated execution input, while list/detail recursively replace values for `apiKey`, `token`, `authorization`, and `password` keys with `"[redacted]"`. Never mutate the broker's stored object while redacting.

Implement wait with server constants:

```ts
const WAIT_TIMEOUT_MS = parsePositiveInt(process.env.JOB_WAIT_TIMEOUT_MS, 25_000);
const WAIT_POLL_MS = parsePositiveInt(process.env.JOB_WAIT_POLL_MS, 250);
```

- [ ] **Step 4: Mount only `/api/jobs`**

Replace `api.route("/ai-jobs", ...)` with `api.route("/jobs", ...)`. Return `202` from wait when the job is non-terminal and `200` otherwise. The create endpoint remains available for trusted/manual operations but returns `202`, not `201`.

Register `/schedules` before `/:id` so Hono never treats `schedules` as a job ID. Register `/:id/wait`, heartbeat, complete, fail, cancel, and retry before the terminal `GET /:id` handler.

- [ ] **Step 5: Verify**

Run: `npm test -w @magpie/api && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/features/jobs
git commit -m "feat(api): expose durable job lifecycle endpoints"
```

### Task 5: Make domain completion idempotent

**Files:**
- Modify: `apps/api/src/stores/proposal-store.ts`
- Modify: `apps/api/src/stores/postgres-proposal-store.ts`
- Modify: `apps/api/src/features/proposals/service.ts`
- Modify: `apps/api/src/features/crunch/service.ts`
- Modify: `apps/api/src/features/jobs/service.ts`
- Modify: relevant tests under `apps/api/src/features/**`
- Create: `packages/db/migrations/0013_queue_job_idempotency.sql`

- [ ] **Step 1: Add repeated-completion tests**

Complete the same answer, proposal, and crunch job twice. Assert one proposal row, one crunch transition, and the same question answer. For proposal creation, assert the returned proposal ID is unchanged.

- [ ] **Step 2: Verify proposal duplication fails**

Run: `npm test -w @magpie/api -- --test-name-pattern="idempotent|twice"`

Expected: FAIL because proposal creation generates a second ID.

- [ ] **Step 3: Add store lookup/upsert by job ID**

Extend `ProposalStore` with `getByJobId(jobId)`. In-memory creation returns the existing proposal when `jobId` matches. Postgres uses a unique partial index and `INSERT ... ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO UPDATE SET job_id = EXCLUDED.job_id RETURNING *`.

Migration:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS proposals_job_id_unique
  ON proposals (job_id) WHERE job_id IS NOT NULL;
```

Make question and crunch completion naturally convergent by reading the linked record first and returning its terminal value.

- [ ] **Step 4: Apply side effects before queue acknowledgement**

In `completeJob`, dispatch the type-specific domain handler first, then call `ctx.jobs.complete`. Store `{ result: validatedOutput, executor: workerName }` as the queue output envelope. Ensure `failJob` marks a linked crunch run failed only when the broker reports permanent `failed`, not while state is `retry`.

- [ ] **Step 5: Verify**

Run: `npm test -w @magpie/api && npm run db:migrate && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src packages/db/migrations/0013_queue_job_idempotency.sql
git commit -m "fix(api): make job completion idempotent"
```

### Task 6: Convert every generative API feature to enqueue-only

> **Design amendment (2026-06-20, confirmed by Adam): routing + retrieval move to the watcher.**
> The original plan pre-retrieved `context` in the API and embedded it in `answer_question`.
> But `ask()` flow-routing (`routeQuestionToFlow`) is a *generative* call that must run
> **before** retrieval (the chosen flow scopes which repo is searched), which conflicts with
> "the API never calls a generative chat provider". Resolution: order is **route → retrieve →
> answer**, all performed by the watcher. Because the watcher is HTTP-only and cannot reach the
> pgvector index, the API exposes a new **non-generative** `POST /api/retrieve` endpoint the
> watcher calls. Concretely, in this task:
> - **`@magpie/jobs` schema change** (`packages/jobs/src/schemas.ts`, and `@magpie/core`
>   `AnswerQuestionJobInput`): drop the pre-fetched `context` array from `answerQuestionInputSchema`;
>   add `flows: { id, name, persona? }[]` (routing candidates, may be empty). Add optional
>   `flowId` to `answerQuestionOutputSchema` so completion can record the routed flow.
> - **`ask()`**: no direct branch, no API-side routing, no API-side retrieval. Record the question
>   log (flow/sections unknown at enqueue), then `ctx.jobs.create("answer_question", { question,
>   flows, provider, questionLogId, expectedOutput: "answer_result" })`. Route returns `202`.
> - **New `POST /api/retrieve`** (mount in `app.ts`): body `{ question, flowId?, limit? }`; resolves
>   `flowId` → flow → `destinationId`/`repositoryIds` server-side, runs `knowledgeIndex.search`
>   (unscoped if no `flowId`), returns `{ sections: { sectionId, path, heading, content }[] }`.
>   No generative calls; embeddings stay in the API.
> - **Completion handler** (`updateQuestionLogFromCompletedJob`): also persist the output `flowId`
>   and `retrievedSectionIds` (derive from citations) on the question log.
> - **Delete `ctx.providers.chat`, `createConfiguredChatProvider`, and the `routingChatProvider`
>   helper** — the watcher owns routing now (implemented in **Task 7**: the answer runner routes
>   among `flows`, calls `/api/retrieve`, then answers and derives citations from retrieved sections).
> - Remove the transitional `"mock" → "openai-compatible"` provider mapping in ask/proposals/crunch
>   (real provider is required once Direct/mock is gone; full mock removal is Task 11).

**Files:**
- Modify: `packages/jobs/src/schemas.ts`
- Modify: `packages/core/src/index.ts` (AnswerQuestionJobInput/Output contract)
- Modify: `apps/api/src/features/ask/service.ts`
- Modify: `apps/api/src/features/ask/routes.ts`
- Modify: `apps/api/src/features/ask/service.test.ts`
- Create: `apps/api/src/features/retrieve/routes.ts` (+ `service.ts`, `service.test.ts`)
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/features/jobs/service.ts` (completion records flowId + retrievedSectionIds)
- Modify: `apps/api/src/features/proposals/service.ts`
- Modify: `apps/api/src/features/proposals/routes.ts`
- Modify: `apps/api/src/features/proposals/service.test.ts`
- Modify: `apps/api/src/features/crunch/service.ts`
- Modify: `apps/api/src/features/crunch/routes.ts`
- Modify: `apps/api/src/features/crunch/service.test.ts`
- Modify: `apps/api/src/features/gaps/service.ts`
- Modify: `apps/api/src/features/gaps/routes.ts`
- Create: `apps/api/src/features/gaps/service.test.ts`

- [ ] **Step 1: Rewrite behavior tests first**

Assert every feature creates a catalog-valid job and returns immediately:

```ts
test("ask always records and enqueues an answer job", async () => {
  const ctx = makeTestContext();
  const outcome = await ask(ctx, "How does X work?");
  assert.equal(outcome.job.type, "answer_question");
  assert.equal((await ctx.jobs.get(outcome.job.id))?.state, "created");
  assert.equal((await ctx.stores.questionLogs.get(outcome.questionId))?.answer, undefined);
});
```

Add analogous proposal and crunch assertions. Add a gap clustering test asserting `requestClusters()` enqueues `cluster_gap_candidates` instead of calling `ctx.providers.chat`. Add proposal/crunch publication tests asserting publish endpoints enqueue `publish_proposal`/`publish_crunch` rather than executing git in the API.

- [ ] **Step 2: Run and verify Direct branches fail expectations**

Run: `npm test -w @magpie/api -- --test-name-pattern="always|enqueues|clustering"`

Expected: FAIL on current Direct behavior.

- [ ] **Step 3: Remove Direct implementations from feature services**

Delete `draftMarkdownProposalDirect`, `createMockMarkdownProposal`, and `crunchKnowledgeBaseDirect`. `ask`, `draftFromGaps`, and `triggerCrunchRun` always call `ctx.jobs.create` with the selected `AI_PROVIDER` embedded in input. Every route returns `202` with links to `/api/jobs/:id`, `/wait`, and `/cancel`.

```ts
// Per the design amendment: no API-side routing or retrieval. Pass the routing
// candidate flows; the watcher routes, calls POST /api/retrieve for scoped sections,
// then answers. See the amendment block at the top of Task 6.
const job = await ctx.jobs.create("answer_question", {
  questionLogId: log.id,
  question,
  flows: ctx.knowledgeConfig.flows.map((flow) => ({
    id: flow.id, name: flow.name, ...(flow.persona ? { persona: flow.persona } : {})
  })),
  provider: ctx.config.get().aiProvider,
  expectedOutput: "answer_result"
});
return { questionId: log.id, job };
```

Change gap clustering to `POST /api/gaps/clusters`, returning `202` and a job. Keep `GET /api/gaps/candidates`; remove synchronous AI clustering from GET paths. The cluster output completion needs no domain table because clients consume the job output.

Change proposal and crunch publish routes to return `202` publication jobs. Their completion handlers record the validated publication on the linked proposal/run. Move `LocalGitProposalPublisher`, `raisePullRequest`, and publication payload assembly out of API execution paths; the API may retain pure branch-name/body helpers consumed through `@magpie/core` or copied into the watcher-facing contract package.

Add `GET /api/proposals/:id/execution-context` and `GET /api/crunch/runs/:id/execution-context`. Each returns only the requested domain record plus the resolved repository configuration needed by the publication runner; it never includes credentials. Return 404/409 using the same repository validation errors as the old synchronous publish services.

```ts
return c.json({
  proposal,
  repository: {
    id: repository.id, localPath: repository.localPath, remoteUrl: repository.remoteUrl,
    defaultBranch: repository.defaultBranch, git: repository.git
  }
});
```

- [ ] **Step 4: Remove API chat-provider dependency from context**

Delete `ctx.providers.chat` and `createConfiguredChatProvider` from API composition. Keep embedding provider configuration because retrieval embeddings are not generative jobs.

- [ ] **Step 5: Verify**

Run: `npm test -w @magpie/api && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/features apps/api/src/context.ts apps/api/src/platform/providers.ts
git commit -m "refactor(api): enqueue all generative work"
```

### Task 7: Refactor watcher runners and add Azure

**Files:**
- Modify: `apps/watcher/package.json`
- Create: `apps/watcher/src/capabilities.ts`
- Create: `apps/watcher/src/capabilities.test.ts`
- Create: `apps/watcher/src/http-client.ts`
- Create: `apps/watcher/src/worker-loop.ts`
- Create: `apps/watcher/src/worker-loop.test.ts`
- Create: `apps/watcher/src/runners/types.ts`
- Create: `apps/watcher/src/runners/chat.ts`
- Create: `apps/watcher/src/runners/chat.test.ts`
- Create: `apps/watcher/src/runners/cli.ts`
- Create: `apps/watcher/src/runners/cli.test.ts`
- Create: `apps/watcher/src/runners/publication.ts`
- Create: `apps/watcher/src/runners/publication.test.ts`
- Create: `apps/watcher/src/runners/index.ts`
- Modify: `apps/watcher/src/main.ts`
- Modify: `apps/watcher/src/job-prompts.ts`

- [ ] **Step 1: Add watcher test tooling and capability tests**

Add `@magpie/jobs`, `@magpie/retrieval`, and `@magpie/git` as watcher workspace dependencies, run `npm install`, and add the same `node:test` script used by other packages. Test that OpenAI requires base URL/key/model, Azure requires endpoint/key/deployment, Codex/Claude require their configured CLI path/provider selection, GitHub requires `GITHUB_TOKEN` plus git author identity, and maintenance is always available. Assert no `mock` capability exists.

- [ ] **Step 2: Add worker-loop cancellation tests**

Using a fake HTTP client and runner, assert: capabilities are sent on claim; heartbeat starts at half the catalog heartbeat; a heartbeat returning `cancelled` aborts the runner; success completes once; errors fail once; shutdown aborts active work.

- [ ] **Step 3: Run and observe missing modules**

Run: `npm test -w @magpie/watcher`

Expected: FAIL because the capability and worker-loop modules do not exist.

- [ ] **Step 4: Implement small runner interfaces and HTTP client**

```ts
export interface JobRunner {
  readonly capability: JobCapability;
  supports(type: JobType): boolean;
  run(job: JobView, signal: AbortSignal): Promise<unknown>;
}
```

The HTTP client owns `/api/jobs/claim`, `/:id/heartbeat`, `/:id/complete`, and `/:id/fail`. It sends `workerName` on completion/failure so terminal diagnostics can record the executor.

- [ ] **Step 5: Implement hosted and CLI runners**

Use `createChatProvider` for OpenAI-compatible and Azure chat completions, `buildPrompt(job)` for job-specific instructions, and `parseJobOutput` before returning. Add `signal` support to retrieval chat providers so HTTP abort reaches `fetch`.

Extract the existing CLI spawn logic. On abort send `SIGTERM`, wait `CLI_CANCEL_GRACE_MS` (default 5000), then `SIGKILL`. Preserve prompt arg/stdin modes and timeout behavior.

```ts
signal.addEventListener("abort", () => {
  child.kill("SIGTERM");
  forceKillTimer = setTimeout(() => child.kill("SIGKILL"), cancelGraceMs);
}, { once: true });
```

Implement `publish_proposal` and `publish_crunch` runners with `@magpie/git`. They fetch the proposal/run plus resolved repository metadata from API execution endpoints, publish using the shared checkout, and return only the schema-defined publication result. They are registered only with the `github` capability, which requires `GITHUB_TOKEN`, `MAGPIE_GIT_AUTHOR_NAME`, and `MAGPIE_GIT_AUTHOR_EMAIL`.

- [ ] **Step 6: Reduce `main.ts` to composition**

Build configured runners, derive capabilities, log readiness without secrets, start `WorkerLoop`, and stop on SIGINT/SIGTERM. Delete the inline mock runner and monolithic provider switch.

```ts
const runners = createConfiguredRunners(process.env);
const loop = new WorkerLoop(apiClient, runners, watcherName, pollIntervalMs);
process.once("SIGTERM", () => void loop.stop());
process.once("SIGINT", () => void loop.stop());
await loop.run();
```

- [ ] **Step 7: Verify**

Run: `npm test -w @magpie/watcher && npm run build -w @magpie/watcher && npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/watcher packages/retrieval package-lock.json
git commit -m "refactor(watcher): add capability-based job runners"
```

### Task 8: Move scheduled work to pg-boss jobs

> **Scope note (added 2026-06-21):** Task 8 also inherits Task 6's deferred 6E. The
> remaining API generative-chat callers are scheduled background tasks — `gap-reconciler`
> `proposeReshape`/`criticConfirm` and `source-sync` `generateSyncPlan` (both in
> `scheduling/task-registry.ts`). Task 8 must convert these to the queue/watcher model (their
> chat work runs on watchers, not the API), and **only then delete `ctx.providers.chat` +
> `createConfiguredChatProvider`** from API composition (keep the embedding provider). Note
> `source_change_sync` is not yet a registered job type and the reconciler reshape/critic does
> not map onto `cluster_gap_candidates`; design the needed contracts here (a brainstorm pass is
> warranted before implementing).

> **Design amendment (2026-06-21, brainstormed + confirmed by Adam).**
> Three decisions settle the open contract/architecture questions:
>
> 1. **Reshape = one combined AI job `reconcile_gap_clusters`.** Input `{ clusters:[{id,flowId?,title}], flowId? }`;
>    output `{ merges:[{clusterIds,rationale,confirmed}], splits:[{clusterId,children:[{gapIds}],rationale,confirmed}] }`.
>    The watcher chat runner does propose (`GAP_RECONCILE_PROPOSE`) → critic (`GAP_RECONCILE_CRITIC`) per proposal
>    internally and returns only critic-confirmed changes. (Not two separate job types; not critic-less.)
> 2. **Source-sync split:** the API keeps the non-generative gather (git diff + candidate-doc selection — needs
>    checkout + embeddings) behind an endpoint. New AI job `sync_source_changes_generate_plan`
>    (in: `SourceChangeSyncJobInput`, out: `CrunchPlan` — both already in `@magpie/core`) runs the model on a
>    watcher. A new `publish_source_sync` github job (in `{ runId }`) moves the run's git branch write to the
>    watcher publication runner (mirrors `publish_crunch`, no PR).
> 3. **Orchestration location = Option A (pragmatic), a documented deviation from spec line 179.** A schedule
>    emits a per-flow orchestration job; the **maintenance watcher** claims it and POSTs **one thin API endpoint**
>    that runs the existing (now-lightweight) orchestration server-side. The expensive/generative steps still leave
>    the API as AI jobs; drafting/publishing already enqueue (Task 6). We do NOT decompose the whole reconciler loop
>    into many watcher-driven endpoint calls (spec-faithful but a large, risky rewrite). Rationale: after Tasks 6/7
>    the only blocking in-API work left in `reconcileGaps` is the reshape model call (now an AI job) — the remainder
>    is cheap, store-coupled bookkeeping. The real goals (no timers; every run a visible/retryable claimed job;
>    generative + git work on watchers) are met.
>
> **Concrete request paths:**
> - **Gaps→PR:** schedule → per-flow `process_gaps_to_pull_requests` job → maintenance watcher → `POST /api/gaps/reconcile { flowId }`,
>   which runs `reconcileGaps` server-side; `reconcileClusters` **enqueues + bounded-waits `reconcile_gap_clusters`** for
>   the reshape instead of calling `ctx.providers.chat`, then applies confirmed merges/splits.
> - **Source-sync:** schedule → per-flow `source_change_sync` job → maintenance watcher → thin run endpoint; API gathers,
>   enqueues + waits `sync_source_changes_generate_plan`, records the run, enqueues `publish_source_sync`.
> - **`refresh_pull_requests`** is a **github**-capability runner (it needs the token) that does the PR-state check
>   watcher-side; the completion handler applies merged/closed transitions idempotently. **`trigger_scheduled_crunch`** is a
>   maintenance runner that calls the crunch endpoint.
> - Add `apps/watcher/src/runners/maintenance.ts` so the advertised `maintenance` capability gets a real runner
>   (resolves Task 7's `TODO(Task 8)`).
>
> **Sub-tasks (each with two-stage review):**
> - **8A** — add the four new job contracts + Zod schemas to `@magpie/jobs` (`reconcile_gap_clusters`,
>   `sync_source_changes_generate_plan`, `source_change_sync`, `publish_source_sync`); catalog policies + capability routing.
> - **8B** — `ScheduleReconciler` (+ test); wire at startup (after broker start) and after every settings change; remove
>   `lastRunAt`/`nextRunAt`/`runningSince` + `touchSchedule`/`tryAcquireRun`/`releaseRun` from crunch + scheduled-task stores;
>   display next-run from `ctx.jobs.listSchedules()`.
> - **8C — COMPLETE (2026-06-22).** gaps: `reconcile_gap_clusters` chat runner (bespoke propose→critic flow in
>   `apps/watcher/src/runners/chat.ts`, confirmed flags derived from the critic, defensive parsing); `reconcileClusters`
>   now deletes `proposeReshape`/`criticConfirm` and instead enqueues `reconcile_gap_clusters` via the new
>   `runJobToCompletion(ctx, type, input, {deadlineMs})` helper (jobs service) + bounded-waits — best-effort, skips
>   reshape on timeout/failure without throwing (deadline tied to the job's expiry; overridable via
>   `JOB_RUN_TO_COMPLETION_TIMEOUT_MS`). Added `POST /api/gaps/reconcile {flowId?}` (scope `manage:jobs`, returns
>   `{ok:true}`) and a `MaintenanceRunner` (`apps/watcher/src/runners/maintenance.ts`) for
>   `process_gaps_to_pull_requests` that POSTs that endpoint and returns schema-valid `{drafted:0,published:0}` (counts
>   are accrued by the reconcile run's own enqueues, not returned). Resolved the `TODO(Task 8)` in `runners/index.ts`.
>   No completion handler needed: `completeJob`'s side-effect handlers all guard by job type, so the two new types
>   complete cleanly. Schedule emits `process_gaps_to_pull_requests` with input `{}` (registry `input: () => ({})`),
>   so the maintenance runner reconciles the default flow — no per-flow mismatch.
> - **8D** — source-sync: gather endpoint + `source_change_sync` orchestration + `sync_source_changes_generate_plan` AI job
>   + `publish_source_sync` publication job/runner + execution-context endpoint.
> - **8E** — maintenance runners `refresh_pull_requests` + `trigger_scheduled_crunch`; manual `POST /api/scheduled-tasks/:key/run`
>   → job; delete `task-scheduler.ts` + `crunch-scheduler.ts` and their `main.ts` starts.
> - **8F** — remove `ctx.providers.chat` + `createConfiguredChatProvider` (deferred 6E); keep the embedding provider; verify no
>   API generative-chat callers remain.

**Files:**
- Create: `apps/api/src/jobs/schedule-reconciler.ts`
- Create: `apps/api/src/jobs/schedule-reconciler.test.ts`
- Modify: `apps/api/src/features/crunch/service.ts`
- Modify: `apps/api/src/features/crunch/routes.ts`
- Modify: `apps/api/src/features/scheduled-tasks/routes.ts`
- Modify: `apps/api/src/scheduling/task-registry.ts`
- Delete: `apps/api/src/scheduling/crunch-scheduler.ts`
- Delete: `apps/api/src/scheduling/task-scheduler.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/stores/crunch-store.ts`
- Modify: `apps/api/src/stores/postgres-crunch-store.ts`
- Modify: `apps/api/src/stores/scheduled-task-store.ts`
- Modify: `apps/api/src/stores/postgres-scheduled-task-store.ts`
- Create: `apps/watcher/src/runners/maintenance.ts`
- Create: `apps/watcher/src/runners/maintenance.test.ts`

- [ ] **Step 1: Test schedule reconciliation**

Given enabled/disabled crunch flows and scheduled tasks, assert desired schedules use stable keys:

```ts
assert.deepEqual(desired.map(({ type, key }) => [type, key]), [
  ["trigger_scheduled_crunch", "flow:docs"],
  ["refresh_pull_requests", "task:pull-request-refresh"]
]);
```

Assert repeated reconciliation is a no-op and disabling settings unschedules the matching key.

- [ ] **Step 2: Run and verify missing reconciler**

Run: `npm test -w @magpie/api -- --test-name-pattern=schedule`

Expected: FAIL because `ScheduleReconciler` is missing.

- [ ] **Step 3: Implement reconciliation and settings hooks**

`ScheduleReconciler.reconcile()` reads crunch/task settings, builds `DesiredSchedule[]`, and calls `ctx.jobs.reconcileSchedules`. Call it at startup after broker start, and after each settings update. `pg-boss` schedules use `tz: process.env.JOB_SCHEDULE_TIMEZONE ?? "UTC"` and stable `key` values. `ScheduleView.nextRunAt` is calculated with direct dependency `cron-parser` using the same cron/timezone because `getSchedules()` does not expose a portable next-run timestamp.

```ts
const desired: DesiredSchedule[] = [
  ...crunchSettings.map((setting) => ({
    type: "trigger_scheduled_crunch" as const,
    key: `flow:${setting.flowId ?? "default"}`,
    cron: setting.cron,
    input: { flowId: setting.flowId },
    enabled: setting.enabled
  })),
  ...taskSettings.map(toDesiredTaskSchedule)
];
await ctx.jobs.reconcileSchedules(desired);
```

Remove `lastRunAt`/`nextRunAt` calculation and `touchSchedule` methods from stores. Response services join product settings with `ctx.jobs.listSchedules()` for displayed next-run information.

- [ ] **Step 4: Convert manual scheduled-task runs to jobs**

`POST /api/scheduled-tasks/:key/run` enqueues the registered job type and returns `202`. A scheduled crunch orchestration job calls `/api/crunch/run` with `trigger: "scheduled"` and returns its run/job IDs.

- [ ] **Step 5: Implement maintenance runners**

`refresh_pull_requests` fetches `/api/proposals?status=pr-opened`, checks URLs using `@magpie/git` and watcher-side credentials, and returns `{ results }`; its API completion handler applies merged/closed transitions and merge cascades idempotently.

`process_gaps_to_pull_requests` uses API endpoints only: fetch candidates, enqueue/wait for clustering, enqueue/wait for uncovered proposal drafts, promote drafts, enqueue/wait for `publish_proposal` jobs, and count successful publications. It returns counts and respects `AbortSignal` between each request. `trigger_scheduled_crunch` calls the API crunch endpoint and returns IDs.

- [ ] **Step 6: Delete timer startup and verify**

Remove both scheduler imports/starts from `main.ts`.

Run: `npm test -w @magpie/api && npm test -w @magpie/watcher && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/watcher/src apps/watcher/package.json package-lock.json
git commit -m "feat(jobs): execute scheduled work through watchers"
```

### Task 9: Update MCP to use create then wait

**Files:**
- Modify: `apps/mcp/src/main.ts`
- Modify: `docs/mcp.md`

- [ ] **Step 1: Replace queued polling helper with explicit wait**

`askQuestion` must require a job link, call `${status}/wait`, and fall back to detail polling when wait returns a nonterminal state. Map new states (`created`, `retry`, `active`, `failed`, `cancelled`) and unwrap terminal `{ result, executor }` output.

Core loop:

```ts
const waited = readJob(await getJson(`${statusPath}/wait`));
if (waited.state === "completed") return extractAnswer(readResult(waited.output));
return pollForAnswer(statusPath, deadline);
```

- [ ] **Step 2: Remove Direct response handling**

Delete `ask.result` branching and comments describing inline answers. Update timeout errors to include job ID/state without payload data.

- [ ] **Step 3: Verify**

Run: `npm run build -w @magpie/mcp && npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/src/main.ts docs/mcp.md
git commit -m "refactor(mcp): await durable answer jobs"
```

### Task 10: Update web interactions and operations console

**Task 10 — COMPLETE** (commit `006f6bf`; review ✅ Approve). The web app had been refactored into a component
structure since the plan was written; the work landed against the real files,
not the long-gone `page.tsx`/single stylesheet split.

> **Cross-task sequencing (flagged by review):** `ConfigPanel` now posts `{ ai: { provider } }` with no `executionMode`, but the API config route still requires `executionMode` until **Task 11, Step 3** drops it — so config "Apply" will 400 on the branch until Task 11 lands. Expected; Task 11 must land before the live/E2E exercise (Task 14). Not a Task 10 defect (web-only change). **RESOLVED in Task 11 (`134a554`): `/config` now provider-only; the web save works.**

**Task 11 — COMPLETE** (commits `def5313` core, `272b316` retrieval+prompts, `134a554` api, `b57c488` sweep; review ✅ Approve, no issues). Direct (inline) AI execution and the runtime `mock` provider removed everywhere. core: deleted `AiExecutionMode`/`AgentRunner`/`buildMockCrunchPlan`(+helpers) and `executionMode` from `QuestionLog`/inputs (kept `chatProvider`; kept `AiJob*`/`AiJobQueue` ONLY for the Task-12 custom-queue store). retrieval: removed `MockChatProvider`/`MockEmbeddingProvider`/`mock` union members/Direct `answerQuestion`; `createChatProvider`/`createEmbeddingProvider` now THROW on unsupported (no silent fallback); keyword-only retrieval preserved via `embeddingProviderName()===undefined` (no mock embedding). prompts: removed dead `buildJobPrompt`/`build.ts`; relabelled `usedBy` "queue/direct mode"→"watcher". api: `RuntimeConfigHolder` stores only `{aiProvider}`; `fromEnv` THROWS without a supported `AI_PROVIDER` (no mock default); `/config` is provider-only (drops `executionMode` — unblocks Task 10); provider discovery returns the 4 static watcher providers (no secret gating); `executionMode` gone from responses/stores/tests (tests migrated to `codex`). `.env.example` fixed (no `AI_EXECUTION_MODE`/`AI_PROVIDER=mock`). Full repo green: **362 tests pass**, build + typecheck clean. **Deferred:** README/docs "direct mode" prose → Task 13; Postgres `execution_mode` column drop → Task 12.

**Task 12 — COMPLETE** (commit `bfe440c`; review ✅ Approve, no issues). Deleted the legacy custom AI-job-queue: `stores/ai-job-queue.ts`(+test), `stores/postgres-ai-job-queue.ts`(+orphaned test); removed `AI_JOB_QUEUE`/`parseClaimTimeoutMs`/`createAiJobQueue` from `platform/stores.ts`; removed the now-orphaned `AiJob`/`AiJobType`/`AiJobStatus`/`AiJobQueue` types from `@magpie/core` (Task 11 had kept them alive only for this store); dropped the old-store config output. Admin `resetData` now calls `ctx.jobs.reset()` then `reconcileSchedules(ctx)` (cleared settings leave no orphaned pg-boss schedules); `reset-stores.test.ts` rewritten to assert that. Migration **`0024_remove_custom_ai_queue.sql`** (note: NOT 0014 — repo was at 0023): `DROP TABLE ai_jobs`; drop `crunch_settings.last_run_at/next_run_at`, `scheduled_task_settings.last_run_at/next_run_at/running_since`, `questions.execution_mode`; `questions.chat_provider DROP DEFAULT` — all `IF EXISTS`-guarded. Review definitively confirmed migration-vs-store safety (every write supplies `chat_provider`; stores `SELECT *` but map only retained columns; `gap_reconciler_state.last_run_at` is a different table, untouched). **Migration written but UNAPPLIED (no local Postgres) — `0023` + `0024` apply on the real stack / Task 14 E2E.** 219 API tests pass; build + typecheck clean.

**Task 13 — COMPLETE** (commits `e2075c9` env, `05898f9` compose, `ddd3bed` docs/scripts, + `docs/mvp.md` one-line fix; review ✅ Approve). Env examples, Docker Compose, all user docs, `scripts/eval-api.ts`, and `run-cat-demo.ps1` rewritten to the queue-only end state. `.env.example`/`.env.compose.example`: mandatory `DATABASE_URL`+real `AI_PROVIDER`, job knobs (`JOB_WAIT_TIMEOUT_MS`/`JOB_WAIT_POLL_MS`/`JOB_SCHEDULE_TIMEZONE`/`CLI_CANCEL_GRACE_MS`/`JOB_RUN_TO_COMPLETION_TIMEOUT_MS`), per-provider watcher capability detection (matches `capabilities.ts`); removed all mock/execution-mode/claim-timeout/scheduler-tick vars (and dead vars not read by code — `JOB_RETENTION_DAYS` deliberately NOT added). Compose: **Redis removed**; `api`→`migrate`(completed)→`postgres`(healthy), web/watcher/mcp→`api`(healthy); `AI_PROVIDER: ${AI_PROVIDER:?…}` on api+watcher; `CLAUDE_CLI_PATH` left undefaulted so the watcher doesn't falsely advertise the claude capability; `docker compose config` validates. Docs verified against real endpoints/shapes (`/api/jobs/*` wait/cancel/retry/schedules, `{questionId,job,links}` ask 202, `/api/config` provider-only). `eval-api.ts` now create→wait→poll. Review confirmed no dead env vars / no non-existent endpoints documented / sound compose deps+healthcheck. Typecheck + build clean.

**Files actually changed:**
- `apps/web/src/lib/types.ts` — dropped `AiExecutionMode` + old `AiJob`; re-export `JobView`/`JobState`/`JobType`/`JobError`/`AiProviderName` types from `@magpie/jobs`; added `ScheduleView`, paginated `JobsResponse`, `CrunchSettingsView`, `ScheduledTaskSettingsView`, and the enqueue-only `AskResponse` (`{ questionId, job, links? }`). `AI_PROVIDERS` is a local `as const satisfies readonly AiProviderName[]` constant — deliberately NOT imported from `@magpie/jobs` so the client bundle never pulls zod + the job catalog (a runtime value import of it broke the Turbopack build).
- `apps/web/src/lib/console.ts` — `buildAttentionNotices`/`isActiveJob`/`jobTransitionMessages` now key off `JobView.state` (`created|retry|active|blocked` active; `completed|failed|cancelled` terminal); dropped the `executionMode === "queue"` gate (queue-only world always needs a watcher).
- `apps/web/src/components/ConsoleProvider.tsx` — `jobs` state is `JobView[]`; `/ai-jobs` → `/jobs?limit=100` (`JobsResponse`); added `/jobs/schedules` fetch; the single reusable `waitForJob(Pick<JobView,"id">)` helper used after ask, proposal draft, gap-cluster draft, crunch (via `run.jobId`), and manual scheduled-task run; new `selectJob`/`cancelJob`/`retryJob` actions for the panel.
- `apps/web/src/components/JobsPanel.tsx` — full rewrite: state/type filters, totals, attempt/age/timing columns, selected-job detail (redacted input/output/error + timings), cancel for created/retry/active, retry for failed, active-schedules table.
- `apps/web/src/components/ConfigPanel.tsx` — execution-mode state/select and support-flag logic removed; provider select is the four static `AI_PROVIDERS`; saves `{ ai: { provider } }`; no `mock`.
- `apps/web/src/components/AskPanel.tsx` — answer now read from the question log (the watcher writes it on completion); the live block shows job state while queued.
- `apps/web/src/components/AppShell.tsx` — "Mode" status line replaced with active "Provider"; latest-job badge uses `.state`.
- `apps/web/src/components/CrunchPanel.tsx` — schedule editor reads only `enabled`/`cron`/`nextRunAt`; dropped `lastRunAt`/`runningSince` UI (gone server-side).
- `apps/web/src/app/jobs/page.tsx`, `apps/web/src/app/styles.css` — wire the new panel props; add jobs/schedule/detail CSS.

**Resolution of the deferred Task-6 item:** `ConsoleProvider` no longer reads
`answer.mode`/`answer.result`. The refresh effect keeps `answer.job` fresh from
the `/jobs` list (the answer itself lands on the question log, which `AskPanel`
renders); the ask handler `waitForJob`s the queued `answer_question` job. Publish
handlers read `{ job }` and wait on it.

**Verified:** `npm run typecheck -w @magpie/web` ✅, `npm run build -w @magpie/web` ✅, focused `eslint` on all changed files ✅ (web has no lint/test scripts of its own). No `/ai-jobs`, `AiExecutionMode`, `executionMode`, or `mock` provider remains in `apps/web/src`.

<details><summary>Original step plan (for reference)</summary>

- [x] **Step 1: Replace client types**

Remove `AiExecutionMode` and old `AiJob`. Add `JobView`, `ScheduleView`, paginated `JobsResponse`, and provider names without `mock`. Rename all `/ai-jobs` requests to `/jobs`.

- [x] **Step 2: Add one reusable wait helper**

```ts
async function waitForJob(job: JobView): Promise<JobView> {
  const waited = await apiGet<{ job: JobView }>(`/jobs/${job.id}/wait`);
  if (["completed", "failed", "cancelled"].includes(waited.job.state)) return waited.job;
  return waited.job;
}
```

Use it after ask, proposal draft, gap clustering, crunch, and manual scheduled-task creation. If still active, show a queued message and let normal refresh polling update the page.

- [x] **Step 3: Replace the Jobs panel**

Add state/type filters, totals, attempt/age/timing columns, selected job detail with redacted input/output/error, cancel for created/retry/active, retry for failed, and an active schedules table. Fetch `/jobs?limit=100`, `/jobs/:id`, and `/jobs/schedules`.

- [x] **Step 4: Simplify Config panel**

Remove execution-mode state/select and support flags. Provider selection contains the four statically supported names `openai-compatible`, `azure-openai`, `codex`, and `claude`; API-side credentials do not control availability because credentials belong to watchers. Saving posts `{ ai: { provider } }`. Remove all mock fallbacks.

- [x] **Step 5: Update schedule displays**

Use reconciled schedule response values for next run. Remove UI assumptions that `lastRunAt` is maintained by API tick loops.

- [x] **Step 6: Verify**

Run: `npm run typecheck -w @magpie/web && npm run build -w @magpie/web`

Expected: PASS. (Confirmed.)

- [x] **Step 7: Commit**

Staged precisely against the real refactored web files (see the file list above), not the long-removed `page.tsx`.

</details>

### Task 11: Remove Direct mode and runtime mock support

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/retrieval/src/index.ts`
- Modify: `packages/retrieval/src/index.test.ts`
- Modify: `packages/retrieval/src/embeddings.ts`
- Modify: `packages/retrieval/src/embeddings.test.ts`
- Modify: `packages/prompts/src/catalog.ts`
- Modify: `packages/prompts/src/catalog.test.ts`
- Modify: `packages/prompts/src/types.ts`
- Modify: `apps/api/src/config-holder.ts`
- Modify: `apps/api/src/features/config/routes.ts`
- Modify: `apps/api/src/features/config/service.ts`
- Create: `apps/api/src/features/config/service.test.ts`
- Modify: tests containing `executionMode: "direct"` or `chatProvider: "mock"`

- [ ] **Step 1: Add negative config tests**

Assert `normalizeAiProvider("mock")` is undefined, provider config defaults do not invent a provider, and startup fails with a clear error when `AI_PROVIDER` is absent or unconfigured.

- [ ] **Step 2: Remove obsolete contracts and implementations**

Delete `AiExecutionMode`, `AiJob*`, `AiJobQueue`, `AgentRunner`, `buildMockCrunchPlan`, and deterministic mock job helpers from core; job contracts now come from `@magpie/jobs`. Remove `MockChatProvider`, mock embedding selection, Direct `answerQuestion`, and Direct answer prompt. Retain keyword-only retrieval when no embedding provider is configured; do not replace it with a mock embedding.

Remove `ANSWER_QUESTION_DIRECT` and update prompt `usedBy` labels from “queue mode” to “watcher”.

- [ ] **Step 3: Simplify runtime provider config**

`RuntimeConfigHolder` stores only `{ aiProvider }`. `POST /config` accepts provider only. Provider discovery returns the four statically supported watcher providers; it does not inspect API-side secrets. Reset returns to `AI_PROVIDER` from environment and fails rather than defaulting to mock.

```ts
static fromEnv(): RuntimeConfigHolder {
  const aiProvider = normalizeAiProvider(process.env.AI_PROVIDER);
  if (!aiProvider) throw new Error("AI_PROVIDER must name a supported watcher provider");
  return new RuntimeConfigHolder({ aiProvider });
}
```

Remove `executionMode` from `QuestionLog`, question-store record inputs, API responses, and tests because it is constant and no longer informative. Keep `chatProvider` as the selected real provider name. Tests use `codex` or another valid provider label with injected fakes, never product `mock`.

- [ ] **Step 4: Verify no runtime references remain**

Run:

```bash
rg -n 'AI_EXECUTION_MODE|AiExecutionMode|direct mode|provider === "mock"|AI_PROVIDER=mock' apps packages .env.example README.md docs
```

Expected: only historical design/plan documents may match. A second `rg -n '\bmock\b' apps packages --glob '*.ts'` returns no runtime implementation; test doubles are named `Fake*`.

Run: `npm test && npm run build && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages apps/api/src apps/api/package.json package-lock.json
git commit -m "refactor: remove direct and mock AI execution"
```

### Task 12: Remove custom queue persistence and scheduler columns

**Files:**
- Delete: `apps/api/src/stores/ai-job-queue.ts`
- Delete: `apps/api/src/stores/ai-job-queue.test.ts`
- Delete: `apps/api/src/stores/postgres-ai-job-queue.ts`
- Modify: `apps/api/src/platform/stores.ts`
- Modify: `apps/api/src/stores/reset-stores.test.ts`
- Modify: `apps/api/src/features/config/service.ts`
- Modify: `apps/api/src/features/config/service.test.ts`
- Create: `packages/db/migrations/0014_remove_custom_ai_queue.sql`

- [ ] **Step 1: Add migration**

```sql
DROP TABLE IF EXISTS ai_jobs;
ALTER TABLE crunch_settings DROP COLUMN IF EXISTS last_run_at;
ALTER TABLE crunch_settings DROP COLUMN IF EXISTS next_run_at;
ALTER TABLE scheduled_task_settings DROP COLUMN IF EXISTS last_run_at;
ALTER TABLE scheduled_task_settings DROP COLUMN IF EXISTS next_run_at;
ALTER TABLE questions DROP COLUMN IF EXISTS execution_mode;
ALTER TABLE questions ALTER COLUMN chat_provider DROP DEFAULT;
```

- [ ] **Step 2: Delete factories and compatibility overrides**

Remove `AI_JOB_QUEUE`, `parseClaimTimeoutMs`, `createAiJobQueue`, old reset coverage, and config output for the old store. Admin reset calls `ctx.jobs.reset()` and then reconciles schedules.

- [ ] **Step 3: Apply migration and verify**

Run: `npm run db:migrate`

Expected: `0014_remove_custom_ai_queue.sql` applies successfully.

Run: `npm test -w @magpie/api && npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src packages/db/migrations/0014_remove_custom_ai_queue.sql
git commit -m "chore(db): remove custom AI queue storage"
```

### Task 13: Update runtime configuration, Compose, and documentation

**Files:**
- Modify: `.env.example`
- Modify: `.env.compose.example`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `docs/ai-jobs.md`
- Modify: `docs/api.md`
- Modify: `docs/architecture.md`
- Modify: `docs/chat-providers.md`
- Modify: `docs/ingestion.md`
- Modify: `docs/question-logging.md`
- Modify: `scripts/eval-api.ts`
- Modify: `scripts/run-cat-demo.ps1`

- [ ] **Step 1: Rewrite environment examples**

Remove `AI_EXECUTION_MODE`, `AI_JOB_QUEUE`, `CHAT_PROVIDER`, `AI_JOB_PROVIDER`, mock values, claim timeout, and scheduler tick variables. Require `DATABASE_URL` and a real `AI_PROVIDER`. Add:

```dotenv
JOB_WAIT_TIMEOUT_MS=25000
JOB_WAIT_POLL_MS=250
JOB_SCHEDULE_TIMEZONE=UTC
JOB_RETENTION_DAYS=30
WATCHER_POLL_INTERVAL_MS=2000
CLI_CANCEL_GRACE_MS=5000
```

Document watcher capability detection and Azure watcher variables.

- [ ] **Step 2: Update Compose**

Keep API and watcher as distinct services sharing only HTTP and the checkout volume. Remove Redis because no runtime component uses it. Ensure API waits for migrations/Postgres and watcher waits for API health. Configure a real provider through `.env.compose`; do not ship a fake default.

Expose explicit Compose overrides on both API and watcher so E2E can select a fixture without editing files:

```yaml
environment:
  AI_PROVIDER: ${AI_PROVIDER:?AI_PROVIDER must be set}
```

The watcher also maps provider-specific variables including `CODEX_CLI_PATH: ${CODEX_CLI_PATH:-codex}`.

- [ ] **Step 3: Rewrite user docs and eval script**

Document `POST -> 202 -> /jobs/:id/wait -> poll`, all job states, cancellation/retry, schedules, mandatory Postgres, and atomic API/watcher deployment. Update evals to use the wait endpoint. Remove all Direct/mock instructions.

- [ ] **Step 4: Scan for stale public behavior**

Run:

```bash
rg -n 'AI_EXECUTION_MODE|AI_JOB_QUEUE|AI_PROVIDER=mock|/ai-jobs|direct mode|queue mode|redis' \
  README.md docs .env.example .env.compose.example docker-compose.yml scripts apps packages \
  --glob '!docs/superpowers/**'
```

Expected: no obsolete runtime/documentation matches; “queue” may remain only as the generic job-queue concept.

- [ ] **Step 5: Commit**

```bash
git add .env.example .env.compose.example docker-compose.yml README.md docs scripts
git commit -m "docs: document queue-only job execution"
```

### Task 14: Add end-to-end queue lifecycle coverage

**Files:**
- Create: `scripts/e2e-jobs.ts`
- Create: `scripts/fixtures/test-agent.mjs`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add an executable smoke test**

The fixture CLI reads its prompt from argv/stdin and behaves deterministically: valid JSON for ordinary job types, a delayed valid answer when the question contains `[slow]`, and a non-zero exit when it contains `[fail]`. It is test-only and selected explicitly with `CODEX_CLI_PATH`.

The E2E script must:

1. create an answer job through `/api/ask`;
2. wait for completion and validate answer output;
3. create a `[slow]` answer, cancel it, and assert `cancelled`;
4. create a `[fail]` answer and assert retry metadata followed by permanent failure;
5. list jobs and schedules and confirm created IDs/schedule keys are visible.

This is test instrumentation, not a runtime mock provider: the controlled CLI path is an explicit E2E fixture and is not a selectable product provider.

- [ ] **Step 2: Add script and run full stack**

Add:

```json
"e2e:jobs": "node --import tsx scripts/e2e-jobs.ts"
```

Run:

```bash
AI_PROVIDER=codex CODEX_CLI_PATH=/app/scripts/fixtures/test-agent.mjs \
  docker compose --profile app up -d --build
npm run e2e:jobs
```

Expected: answer, cancellation, retry, job-list, and schedule-list scenarios all pass.

- [ ] **Step 3: Run every final gate**

```bash
npm test
RUN_PG_INTEGRATION=1 npm run test:integration
npm run build
npm run typecheck
docker compose --profile app ps
```

Expected: all tests/build/typecheck pass; API, web, watcher, and Postgres are healthy/running; migrate exited successfully.

- [ ] **Step 4: Perform final behavior checklist**

- Ask from web and MCP: create, bounded wait, terminal answer.
- Draft one proposal and a clustered proposal: both appear after job completion.
- Run crunch manually and via schedule: run links to job and receives plan.
- Cancel active Codex/Claude work: child process exits and job is cancelled.
- Force one provider error: retry/backoff then permanent failure is visible.
- Retry a failed job manually: state returns to queued/retry and executes.
- Enable/disable each schedule: operations view reflects it without API restart.
- Run PR refresh with and without GitHub capability: capable watcher claims it; otherwise it remains queued.
- Reset data: domain stores and jobs clear, schedules reconcile from saved/default settings.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/e2e-jobs.ts scripts/fixtures/test-agent.mjs README.md
git commit -m "test: cover queue-only job lifecycle"
```

## Final Review

Before opening the branch for merge:

```bash
git status --short
git log --oneline --decorate origin/feat/shared-prompt-catalog..HEAD
rg -n 'AI_EXECUTION_MODE|AI_JOB_QUEUE|AI_PROVIDER=mock|/api/ai-jobs' . \
  --glob '!node_modules/**' --glob '!docs/superpowers/**'
```

Expected: clean worktree, only intentional commits, and no obsolete runtime contract references.
