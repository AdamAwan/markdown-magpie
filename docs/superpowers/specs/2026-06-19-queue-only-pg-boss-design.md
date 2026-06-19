# Queue-Only Job Execution with pg-boss — Design

**Date:** 2026-06-19  
**Status:** Approved  
**Scope:** Replace Direct AI execution, the custom AI queue, and the in-process cron schedulers with one Postgres-backed job system executed by capability-filtered watchers.

## Background

Markdown Magpie currently has two AI execution paths. In Direct mode the API calls a hosted model inline and holds the originating request or scheduler tick open. In Queue mode the API persists an `ai_jobs` row and an external watcher claims and executes it. The two paths duplicate provider orchestration, output validation, error handling, feature behavior, configuration, tests, and documentation.

The custom queue already implements pending and claimed states, claim expiry, completion, failure, and Postgres locking. Extending it into a production job system would also require retries, backoff, heartbeats, cancellation, cron, retention, dead-letter handling, concurrency controls, and operational inspection. These are established queue responsibilities.

The external watcher protocol is nevertheless a product strength. It lets developers execute work with Codex or Claude Code on their own machine instead of provisioning an API model. This design preserves that protocol while replacing the queue mechanics underneath it.

## Goals

- Use one durable execution path for every generative AI operation.
- Preserve API-mediated, developer-run Codex and Claude watchers.
- Support OpenAI-compatible and Azure OpenAI providers through the same watcher path.
- Make watchers multipurpose and capability-filtered so they can also execute maintenance work.
- Replace custom queue mechanics and cron polling with `pg-boss`.
- Provide one operational view of jobs and active schedules.
- Support explicit bounded waiting for interactive web and MCP callers.
- Add durable retries, heartbeats, cancellation, expiration, retention, and idempotent completion.

## Non-Goals

- Backward compatibility for Direct mode or `/api/ai-jobs`.
- Migrating historical rows from the custom `ai_jobs` table.
- Watcher authentication or authorization.
- Persistent worker registration, worker health, or capability dashboards.
- Queue throughput metrics and alerting.
- Streaming partial model output.
- A runtime mock provider.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| AI execution | Queue only | Removes duplicate behavior and request-lifetime model calls. |
| Compatibility | Breaking removal | The branch will not merge until API, watcher, web, MCP, deployment, and docs move together. |
| Queue engine | `pg-boss` | Reuses mandatory Postgres and supplies retries, heartbeats, cron, cancellation, retention, and queue policies. |
| Runtime storage | Postgres required | An in-memory queue cannot provide durable or multi-process semantics. |
| Worker access | HTTP through the API | Developer watchers do not receive database credentials and completion stays validated centrally. |
| Watcher role | Multipurpose, capability-filtered | A watcher claims only work supported by its configured providers and credentials. |
| Hosted providers | Watcher only | The API never performs generative model calls. |
| Azure | Add an Azure watcher runner | Existing Azure deployments retain provider support after Direct mode is removed. |
| Mock provider | Remove | Tests use injected fakes; runtime configuration exposes only real providers. |
| Scheduling | Move all existing schedules to `pg-boss` | Jobs and schedules share durability and operational visibility. |
| Job record | `pg-boss` is the sole job store | Avoids dual writes and a second job lifecycle model. |
| Interactive waiting | Separate wait endpoint | Creation remains consistently asynchronous while clients can request bounded waiting. |
| Cancellation | Cooperative for queued and active jobs | Long-running CLI and HTTP work can be stopped without treating cancellation as failure. |
| Retry policy | Per job type | Different providers and maintenance tasks have different safe time and retry budgets. |
| Operations UI | Jobs plus schedules | Gives a useful first overview without introducing worker registration or metrics. |
| Authentication | Unchanged and out of scope | This migration preserves the current open watcher boundary by explicit product decision. |

## Architecture

### API control plane

The API owns a single `PgBossJobBroker` instance and remains the only process that talks to `pg-boss`. It:

- creates and queries jobs;
- claims jobs on behalf of watchers;
- records heartbeats with `touch()`;
- validates completion and failure payloads;
- applies idempotent domain side effects;
- completes, fails, cancels, and retries jobs;
- reconciles product schedule settings into `pg-boss` schedules; and
- exposes stable HTTP projections rather than library-private tables.

The API does not execute generative AI. Postgres and a successful `pg-boss` startup are mandatory before the API accepts requests.

### Multipurpose watcher execution plane

`apps/watcher` becomes a registry of small job runners behind one polling loop. At startup it derives capabilities from its environment and advertises the corresponding accepted job types on every claim request.

Initial capabilities are:

- `openai-compatible`
- `azure-openai`
- `codex`
- `claude`
- `github`
- maintenance capabilities for handlers whose required settings are present

A missing provider endpoint, CLI, GitHub token, repository setting, or other required configuration removes the corresponding job types from that watcher. It does not cause the watcher to claim work it cannot run. Multiple watchers with different capability sets may safely share the same API.

Each runner has one purpose: validate its input, execute the external operation, return schema-valid output, respond to abort, and classify safe diagnostics. Runners obtain current application state through API contracts rather than direct Postgres access.

### Job definition catalog

One catalog is the source of truth for every job type. A definition contains:

- stable job type and queue name;
- input and output Zod schemas;
- required watcher capability;
- retry limit, initial delay, exponential-backoff maximum;
- heartbeat interval and hard expiration;
- completed-job retention;
- optional dead-letter queue;
- cancellation support; and
- idempotent completion handler.

AI types initially include `answer_question`, `summarize_gap`, `draft_markdown_proposal`, `detect_contradiction`, `suggest_consolidation`, and `crunch_knowledge_base`. Existing scheduled maintenance operations receive their own job types rather than remaining hidden timer callbacks.

The catalog is runtime-neutral and testable independently. API routing, watcher capability selection, queue provisioning, and operational labels all consume it.

## Job Lifecycle

### Creation and interactive waiting

Every AI-producing feature endpoint creates a durable job and returns `202`:

- `/api/ask` records the question and returns its question ID and job links.
- Proposal drafting returns its job links; the proposal appears after validated completion.
- Crunch creates a running `CrunchRun` linked to the job and returns immediately.
- Cron schedules emit normal jobs with the same lifecycle as manually requested work.

Job creation never waits. Interactive web and MCP clients call `GET /api/jobs/:id/wait`. The endpoint waits up to a server-controlled limit, defaulting to 25 seconds. It returns `200` with a terminal job or `202` with the current projection when the limit expires. Clients then poll the normal detail endpoint. Arbitrary client-selected wait durations are not accepted.

### Claim and execution

The watcher calls `POST /api/jobs/claim` with its name and accepted job types. `pg-boss.fetch()` operates on one named queue, so the broker fairly rotates across the accepted queue names and fetches one job from the first queue with available work. FIFO ordering is guaranteed within a job type; no global ordering across types is promised. This avoids private-table queries and prevents one busy type from permanently starving the others.

While running, the watcher calls `POST /api/jobs/:id/heartbeat`. The API uses `pg-boss.touch()`. `heartbeatSeconds` detects a dead worker promptly; `expireInSeconds` remains the independent hard upper bound for a live but stale attempt.

The watcher polls through heartbeat responses for cancellation. HTTP runners use `AbortController`. CLI runners first send a graceful termination signal and force termination after a short grace period.

### Completion and idempotency

The watcher submits structured output to `POST /api/jobs/:id/complete`. The API:

1. verifies that the job is active and not cancelled;
2. validates output against the job definition;
3. applies the definition's domain completion handler;
4. records the terminal output with `pg-boss.complete()`; and
5. returns the terminal projection.

The job ID is the idempotency key for every domain side effect. Question updates, proposal creation, crunch-plan attachment, pull-request refresh, and other maintenance effects must return the existing result when called again. Side effects run before queue acknowledgement. If acknowledgement fails after a side effect succeeds, redelivery cannot duplicate the effect.

If output validation or the completion handler fails, the API fails the active attempt with a safe structured error instead of leaving it active. A partially applied completion handler is reconciled by the same idempotency rule on retry.

There is an unavoidable at-least-once boundary around external side effects. GitHub writes and CLI-driven effects must use stable branch names, PR lookups, request keys, or equivalent reconciliation so repetition converges on the existing result.

### Failure and retry

Watcher execution failures use one safe error envelope:

```ts
interface JobError {
  code: string;
  message: string;
  category: "provider" | "validation" | "configuration" | "timeout" | "external" | "internal";
  provider?: string;
  details?: Record<string, string | number | boolean | null>;
}
```

Secrets, authorization headers, and unbounded provider responses are never stored. Input and static configuration are validated before enqueue or capability advertisement. Once execution begins, failed attempts use the job type's `pg-boss` retry policy. Invalid model output is an attempt failure and may succeed on a later attempt. Exhausted work becomes permanently failed and retains its final structured error.

Jobs with no capable watcher remain queued and visible. Absence of a worker is not a job failure.

### Cancellation and manual retry

`POST /api/jobs/:id/cancel` delegates to `pg-boss.cancel()` for queued or active jobs. A watcher that observes cancellation aborts and does not report success or failure. A completion submitted after cancellation is rejected.

`POST /api/jobs/:id/retry` delegates to the supported retry API for permanently failed jobs. It does not mutate completed or active jobs.

## Scheduling

The custom `CrunchScheduler` and `TaskScheduler` interval loops are removed. Existing schedule settings remain the product-owned editable configuration:

- crunch settings retain flow, enabled state, and cron;
- registered maintenance-task settings retain task key, enabled state, and cron.

Runtime timestamps maintained by the old polling schedulers are no longer authoritative. On startup and after every settings change, a `ScheduleReconciler` creates, updates, or removes the corresponding `pg-boss` schedule. Schedule names are stable and derived from task type plus flow or task key. Reconciliation is idempotent and safe across multiple API instances.

A schedule emits a normal orchestration or maintenance job. It never directly invokes feature services inside the API process. Multipurpose watchers claim scheduled work using the same capability rules as manually created work.

The operations API lists configured schedules and their library-reported next execution details through supported `pg-boss` APIs. No application code queries private `pg-boss` tables.

## API Contract

The generic base path changes from `/api/ai-jobs` to `/api/jobs`. Old routes are removed.

Required endpoints:

- `GET /api/jobs` — filter by type, state, and date with bounded pagination.
- `GET /api/jobs/:id` — job detail, including archived records during retention.
- `POST /api/jobs/claim` — claim by worker name and accepted job types.
- `POST /api/jobs/:id/heartbeat` — touch an active job and report cancellation state.
- `POST /api/jobs/:id/complete` — validate output, apply idempotent effects, and complete.
- `POST /api/jobs/:id/fail` — store a safe attempt error and enter retry or permanent failure.
- `GET /api/jobs/:id/wait` — bounded wait for a terminal state.
- `POST /api/jobs/:id/cancel` — cancel queued or active work.
- `POST /api/jobs/:id/retry` — retry permanently failed work.
- `GET /api/jobs/schedules` — list active reconciled schedules and next execution details.

The API maps library states into a stable public union without pretending that old custom states remain identical. The contract includes created/queued, retrying, active, completed, failed, cancelled, and blocked where supported.

The job detail projection includes type, state, safe input, safe output/error, retry metadata, heartbeat and expiration metadata, and lifecycle timestamps. Detail lookup resolves an ID by probing only the registered catalog queues through public library APIs. The worker claim response contains the full validated execution payload; UI and general detail responses use a separately redacted projection.

`pg-boss` does not natively store the external claimant's name as job metadata. Terminal output/error records the executor name supplied by the watcher; live worker attribution and health require the future worker-registration feature and are not fabricated here.

## Provider And Configuration Changes

`AiExecutionMode`, `AI_EXECUTION_MODE`, Direct-mode validation, Direct service branches, and Direct-only prompt definitions are removed from core, API, web, MCP, tests, examples, and documentation.

`AI_PROVIDER` remains the selected provider for new AI jobs. Supported runtime providers are:

- `openai-compatible`
- `azure-openai`
- `codex`
- `claude`

The runtime `mock` provider and all UI/configuration choices for it are removed. Unit and integration tests use injected fakes that are not selectable in a running product.

Azure OpenAI gains a watcher runner using the existing endpoint, key, deployment, and API-version settings. Hosted provider secrets stay in watcher environment variables and are never included in job payloads.

`DATABASE_URL` and PostgreSQL 13 or newer become runtime requirements. The API fails startup with a direct configuration error if either the database or `pg-boss` initialization is unavailable.

## Operations Console

The existing Jobs console becomes a general operations view rather than an AI-only list.

The first version includes:

- queue totals and filters by state and type;
- bounded, paginated job history;
- type, state, attempt count, age, and timing in the list;
- detail with safe payload, output, errors, heartbeat, retry, expiration, and timestamps;
- cancel and retry actions when valid; and
- an active schedules table with cron, enabled state, and next run.

Schedule editing remains in the existing feature settings screens. The operations console is for cross-system visibility. Worker health, live capabilities, queue throughput, and alerting are follow-up work.

## Persistence And Retention

`pg-boss` is the sole runtime job record. The custom `ai_jobs` table, Postgres store, and in-memory runtime store are removed. Historical custom jobs are not imported.

The default completed/failed/cancelled retention is 30 days and is configurable globally with per-type overrides only where justified. Queue and archive access use public library APIs. Application migrations do not edit `pg-boss` private tables.

In-memory infrastructure remains permissible only as an injected unit-test fake implementing the application broker interface. No runtime environment may silently fall back to it.

## Migration Strategy

This work lands on one feature branch and is not merged until every consumer has moved. There is no mixed-version compatibility promise.

Recommended implementation sequence:

1. Add the job-definition catalog and broker interface with injected fakes.
2. Add `pg-boss`, queue provisioning, public projections, and Postgres integration tests.
3. Replace job routes with `/api/jobs`, including heartbeat, wait, cancel, and retry.
4. Refactor the watcher into capability-filtered runners; add Azure and maintenance runners.
5. Convert each AI feature to enqueue-only behavior and make completion effects idempotent.
6. Replace both cron schedulers with schedule reconciliation and scheduled job types.
7. Update web and MCP clients for create, wait, and polling behavior.
8. Replace the Jobs console with jobs-and-schedules operations views.
9. Remove Direct mode, mock runtime support, custom queue code/table, old schedulers, env settings, and old routes.
10. Update Compose, examples, deployment configuration, and documentation; run the full end-to-end gate.

The database migration removes the application-owned `ai_jobs` table only after all code references are gone. `pg-boss` owns and migrates its own schema through its supported startup/migration path.

## Testing And Verification

### Unit tests

- Every catalog entry has schemas, capabilities, retry, heartbeat, expiration, retention, and completion behavior.
- Feature services always enqueue and never call chat providers directly.
- Completion handlers are idempotent under repeated delivery.
- Capability detection excludes job types with missing settings.
- Wait, cancellation, state mapping, and safe error serialization are deterministic.
- Schedule reconciliation converges under repeated calls.

Unit tests use injected fake brokers and fake runners, not a runtime mock provider.

### Postgres integration tests

Run against real Postgres and `pg-boss` to cover:

- queue creation and job insertion;
- atomic compatible claims;
- concurrent watchers;
- heartbeat/touch and heartbeat expiry;
- hard expiration;
- retry and exponential backoff;
- permanent failure and manual retry;
- queued and active cancellation;
- completed output and archive lookup;
- retention cleanup; and
- schedule creation, update, removal, and firing.

### Runner contract tests

Each runner must pass success, abort, timeout, invalid-output, and secret-redaction cases. HTTP providers use local fake servers. CLI runners use controlled fake executables. GitHub and maintenance runners use fake API clients.

### API and end-to-end tests

- Every AI-producing endpoint returns `202` plus valid job links.
- Web and MCP wait successfully, then fall back to polling on timeout.
- API-to-watcher-to-completion flows update question, proposal, crunch, and maintenance state.
- Repeated completion cannot duplicate domain or GitHub effects.
- Cancellation aborts active HTTP and CLI work.
- Scheduled work is visible and executed by a capable watcher.
- Work remains queued when no capable watcher exists.
- The operations API and UI filter and display jobs and schedules accurately.

Final gates are root `npm run build`, `npm test`, `npm run typecheck`, and a Compose smoke test with Postgres, API, web, and at least one watcher.

## Risks And Mitigations

- **External worker protocol over a library intended for in-process workers.** Use only public manual-processing APIs: `fetch`, `touch`, `complete`, `fail`, `cancel`, `retry`, queue queries, and schedule APIs. Encapsulate them behind `PgBossJobBroker`.
- **At-least-once external effects.** Require job-ID idempotency and reconciliation for every completion handler and external write.
- **No capable watcher.** Leave work queued and make capability requirements visible in job detail.
- **Long CLI tasks outlive a worker.** Use `heartbeatSeconds` plus `touch()` and an independent conservative hard expiration.
- **Job payloads and outputs expose sensitive data.** Define safe projections and error envelopes; redact secrets before persistence and display.
- **Atomic deployment required.** Keep all changes on one branch and deploy API, watcher, web, and MCP together.
- **Postgres becomes mandatory.** Fail startup clearly and update local Compose/developer commands before removing fallback code.
- **Open watcher endpoints remain a security risk.** Record this explicitly; add authenticated worker registration as the next security project rather than obscuring it inside this migration.

## Follow-Up Work

- Authenticated watcher registration and per-worker credentials.
- Live worker health, capabilities, and active-job attribution.
- Queue throughput, latency metrics, alerting, and capacity guidance.
- Server-sent job updates as an alternative to wait plus polling.
- More granular provider concurrency and rate limiting where operational evidence requires it.

## Library References

- [`pg-boss` project and supported feature summary](https://github.com/timgit/pg-boss)
- [`pg-boss` job APIs, including `fetch`, `touch`, cancellation, retry, and retention](https://raw.githubusercontent.com/timgit/pg-boss/master/docs/api/jobs.md)
- [`pg-boss` queue policies, heartbeat, expiration, and statistics](https://raw.githubusercontent.com/timgit/pg-boss/master/docs/api/queues.md)
