# Queue-Only pg-boss Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Direct AI execution, the custom AI queue, and both API timer schedulers with one Postgres-backed `pg-boss` job system executed by capability-filtered multipurpose watchers.

**Architecture:** `@magpie/jobs` owns provider-neutral job contracts, Zod schemas, capabilities, and per-type policies. The API owns `pg-boss` behind a `JobBroker`, exposes `/api/jobs`, validates/idempotently applies completions, and reconciles product schedule settings. Watchers retain HTTP-only access, advertise capabilities, heartbeat while executing, and run hosted APIs, agent CLIs, GitHub checks, and orchestration tasks.

**Tech Stack:** TypeScript 6 (NodeNext, strict), Node 22.12+, npm workspaces, `pg-boss` 12.18, PostgreSQL 16/pgvector, Hono, Zod, Next.js 16, `node:test` + `tsx`.

---

## Execution Progress (resume marker)

_Updated 2026-06-20. Checkout: repository root. Branch: `feat/queue-only-pg-boss` (pushed)._

- **Task 1 — complete.** Durable job catalog in `@magpie/jobs` (commits `501bd96`..`bbfecc5`). 7/7 jobs tests pass.
- **Task 2 — complete.** `JobBroker` boundary + test-only `FakeJobBroker`, `ctx.jobs` wired, `ctx.stores.aiJobs` removed, jobs feature migrated to `JobView` (commits `17c69a1`..`88c6db7`). Reviewed clean after fixing 2 Important findings (dropped `as never`/assertion casts). 87/87 API tests, root typecheck clean.
  - Deferred Minor findings for the final whole-branch review: `fake-broker.ts` heartbeat doesn't guard illegal/terminal states; fake records no claimant (`void workerName`).
  - Transitional state to undo later: `createAppContext()` uses a `FakeJobBroker` placeholder (`TODO(Task 3)`) — Task 3 replaces it with the real `PgBossJobBroker`; a `"mock"` → `"openai-compatible"` provider mapping in ask/proposals/crunch services is cleaned up in Task 11.
- **Task 3 — complete.** `PgBossJobBroker`, public queue/schedule APIs, fair capability claims, durable lifecycle projection, mandatory Postgres composition, and graceful broker startup/shutdown (commit `ee9ccc8`). Real Postgres gate: 174/174 API tests; root typecheck and focused lint clean.
- **Task 4 — complete.** `/api/jobs` now exposes capability-filtered claim, heartbeat, bounded wait, structured failure, cancel/retry, schedules, catalog-validated completion, filtered pagination, and non-mutating redacted projections (commit `eb6af52`). 38/38 API test files pass; root typecheck and focused lint clean.
- **Task 5 — complete.** Repeated answer, proposal, and crunch completion now converges by job ID; proposal uniqueness is enforced by migration `0022`, queue output records `{ result, executor }`, and retryable crunch failures leave runs active (commit `b63d5cd`). 174 tests pass, migration and root typecheck clean; real Postgres proposal-store suite 6/6.
- **Task 6 — IN PROGRESS.** Convert ask, proposal drafting/publication, crunch planning/publication, and gap clustering to enqueue-only behavior with no API-side generative or Git execution. Decomposed into sub-tasks 6A–6E; see the design amendment at the head of Task 6 (routing+retrieval moved to the watcher with a new `POST /api/retrieve` callback).
  - **6A — complete** (commits `f599658`, `e8cf4b8`). `answer_question` contract changed (input `context`→`flows`, output gains `flowId`); `ask()` is enqueue-only; new pure `POST /api/retrieve`; completion records `flowId`+`retrievedSectionIds`. Spec review ✅; code-quality review fixups applied (unknown `flowId`→422; inert-persona note). 180/180 API tests, jobs+prompts green, typecheck clean. Minimal transitional `TODO(Task 7)` stubs left in `apps/watcher/src/{job-prompts,main}.ts` and `packages/prompts/src/build.ts` (watcher mock answerer emits no citations until Task 7 wires the retrieve callback).
  - **Deferred to Task 11:** `ask()` passes the configured provider through unmapped, so `aiProvider: "mock"` now fails `answer_question` schema validation (mock isn't a job provider). Resolved when Task 11 removes `mock` and makes a real provider mandatory. Do NOT re-add the `mock→openai-compatible` mapping.
  - **Deferred to Task 10:** `apps/web/src/components/ConsoleProvider.tsx` still reads the removed `answer.mode`/`answer.result` fields (optional-chaining-safe, but its ask polling branch no longer fires). Task 10's web rewrite must switch it to rely on `answer.job`.
  - **6B — complete** (commits `3a242f2`, `3d64861`). Proposal drafting enqueue-only; publication converted to a `publish_proposal` job with fail-fast 404/409 pre-flight; `publish_proposal` completion handler records publication idempotently; new `GET /api/proposals/:id/execution-context` (no credentials). Git execution removed from the API; pure branch-name/PR-body helpers kept exported for Task 7. Spec review ✅; code-quality ✅ (Approve) with three minor fixups applied. Necessary behaviour-preserving cascades: `gaps/service.ts` (dead direct-branch removed), `gap-reconciler.ts` `defaultPublish` (sync→enqueue), web `ConsoleProvider.tsx` publish handler (reads `{ job }`). 188/188 API tests, typecheck clean.
  - **6C — complete** (commit `32c9dda` + fixups). Crunch planning enqueue-only (direct/`ctx.background` path deleted, `ctx.background` itself kept); publication converted to a `publish_crunch` job with fail-fast 404/409 pre-flight (incl. crunch-specific `crunch_run_empty_plan`); `publish_crunch` completion handler records publication idempotently (no PR for crunch); new `GET /api/crunch/runs/:id/execution-context` (no credentials). Spec review ✅; code-quality ✅ (Approve) with the empty-plan no-enqueue test added + stale-comment fixups. Minimal web `ConsoleProvider.tsx` publish cascade. 198/198 API tests, typecheck clean.
  - **6D (gaps clustering), 6E (remove `ctx.providers.chat`) — not started.**

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

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/app/styles.css`

- [ ] **Step 1: Replace client types**

Remove `AiExecutionMode` and old `AiJob`. Add `JobView`, `ScheduleView`, paginated `JobsResponse`, and provider names without `mock`. Rename all `/ai-jobs` requests to `/jobs`.

- [ ] **Step 2: Add one reusable wait helper**

```ts
async function waitForJob(job: JobView): Promise<JobView> {
  const waited = await apiGet<{ job: JobView }>(`/jobs/${job.id}/wait`);
  if (["completed", "failed", "cancelled"].includes(waited.job.state)) return waited.job;
  return waited.job;
}
```

Use it after ask, proposal draft, gap clustering, crunch, and manual scheduled-task creation. If still active, show a queued message and let normal refresh polling update the page.

- [ ] **Step 3: Replace the Jobs panel**

Add state/type filters, totals, attempt/age/timing columns, selected job detail with redacted input/output/error, cancel for created/retry/active, retry for failed, and an active schedules table. Fetch `/jobs?limit=100`, `/jobs/:id`, and `/jobs/schedules`.

- [ ] **Step 4: Simplify Config panel**

Remove execution-mode state/select and support flags. Provider selection contains the four statically supported names `openai-compatible`, `azure-openai`, `codex`, and `claude`; API-side credentials do not control availability because credentials belong to watchers. Saving posts `{ ai: { provider } }`. Remove all mock fallbacks.

- [ ] **Step 5: Update schedule displays**

Use reconciled schedule response values for next run. Remove UI assumptions that `lastRunAt` is maintained by API tick loops.

- [ ] **Step 6: Verify**

Run: `npm run typecheck -w @magpie/web && npm run build -w @magpie/web`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/page.tsx apps/web/src/app/styles.css
git commit -m "feat(web): add jobs and schedules operations view"
```

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
