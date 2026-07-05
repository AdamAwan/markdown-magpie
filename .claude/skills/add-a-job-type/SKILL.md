---
name: add-a-job-type
description: Add or change a queued job type in Markdown Magpie (job contract in @magpie/jobs, watcher runner, capability gate, enqueue + output consumption). Use when introducing a new background/AI job, changing a job's payload or routing, or wiring a new watcher capability — anything touching packages/jobs, apps/watcher/src/runners, or apps/api job creation.
---

# Adding a job type

Markdown Magpie is **queue-only**: the API never runs chat/generative work inline. It
records intent and enqueues a job; the **watcher** claims it, does the work (calling back
into the API for scoped context), and posts the result. So a new unit of background work is
a **job type**, and adding one is a cross-cutting change with a fixed shape. Do the steps in
order — the type system forces most of them, but not all.

The **single source of truth for the job contract is `packages/jobs`** (`@magpie/jobs`).
Everything downstream (queue provisioning, watcher claim, console coverage map) is derived
from it — never hardcode a queue name or a provider fan-out anywhere else.

## Decide the routing first

How a job routes to a worker is picked by its **capability spec** in the catalog. Choose one:

- **`"provider"`** — metered AI/generative work. Fans out over the four providers
  (`AI_PROVIDERS` = openai-compatible, azure-openai, codex, claude), keyed off
  `input.provider`. The API enqueues to `type__provider`; whichever provider runner is
  ready claims it. Use for anything that calls a chat model.
- **A bare `JobCapability`** (`"github"`, `"maintenance"`, `"local-git"`) — statically
  scoped, one queue named exactly by the type. Use for git/PR work or thin API-orchestration
  jobs.
- **A fan-out spec `{ field, capabilities, default? }`** — routes over `capabilities` keyed
  off `input[field]`, with `default` for enqueues that omit the field. See `publish_proposal`
  (`{ field: "destination", capabilities: ["github", "local-git"], default: "github" }`).

## The steps

### 1. Register the type — `packages/jobs/src/types.ts`
Add the string to the `JOB_TYPES` tuple. `JobType` is `(typeof JOB_TYPES)[number]`, so this
one edit makes the compiler demand the rest (the `definitions` record is keyed by `JobType`
and won't compile until you add a catalog entry). If it's a new **capability** rather than a
new type, extend the `JobCapability` union here too.

### 2. Define payload schemas — `packages/jobs/src/schemas.ts`
Add `<name>InputSchema` and `<name>OutputSchema` (Zod). Reuse shared domain types from
`@magpie/core` (`packages/core/src/index.ts`) where they exist rather than redefining shapes.
Provider jobs must include `provider` in the input (the `ProviderInput<T>` pattern / the
`define(..., "provider", ...)` path reads `input.provider`).

### 3. Register in the catalog — `packages/jobs/src/catalog.ts`
Add one line to the `definitions` map:
`<name>: define("<name>", <spec>, schemas.<name>InputSchema, schemas.<name>OutputSchema, <expireInSeconds>)`.
`define` derives the policy, capabilities, `requiredCapability(input)`, and `queueName(input)`
for you — including the `type__capability` partitioning (dashes → underscores). **If the job
is provider-routed, also add it to `AI_JOB_TYPES`** in this file — that list is what the API's
global in-flight AI cap counts, and it's a `satisfies readonly JobType[]` so a wrong entry
fails the build. Queues (work + dead-letter) are provisioned automatically from
`allQueueDefinitions()` at broker start; you don't create them.

### 4. Add the watcher runner path — `apps/watcher/src/runners/`
A runner implements `JobRunner` (`runners/types.ts`): `capability`, `supports(type)`,
`run(job, signal)`. Two cases:

- **Provider/generative job** — you usually don't write a new runner. `PROVIDER_JOB_TYPES` is
  *derived* (every type whose `requiredCapability({provider:"codex"})` is `"codex"`), so a
  `"provider"` catalog entry is automatically claimed by `ChatRunner` and the CLI runners,
  which all dispatch to `runGenerativeJob` in `runners/generative.ts`. What you add there is
  the **prompt + output handling**: generic jobs flow through `buildPrompt(job)` +
  `parseJobOutput` (see `job-prompts.ts`); jobs needing bespoke logic get an explicit branch
  (like `answer_question` / `reconcile_gap_clusters`). Register any new prompt in
  `@magpie/prompts` (`packages/prompts/src/catalog.ts`).
- **Non-provider job** — extend the matching runner's `supports()` set and `run()` switch
  (e.g. add the type to `MAINTENANCE_JOB_TYPES` in `runners/maintenance.ts`), or add a new
  runner class and register it in `runners/index.ts` `createConfiguredRunners`, gated by
  `ready("<capability>")`.

### 5. Gate the capability — `apps/watcher/src/capabilities.ts`
Only if you added a **new** capability: add a `CapabilityGate` (its `requiredEnv` + `ready()`).
The invariant is *a capability is advertised on claim iff a runner can execute it* — the gate
in `capabilities.ts` and the `ready(...)` guard in `runners/index.ts` must agree. Existing
capabilities need no change.

### 6. Enqueue it
The API creates jobs via `ctx.jobs.create(type, input)` — see
`apps/api/src/features/jobs/service.ts`. The generic `POST /api/jobs` route accepts any
`JobType`; a feature-specific trigger calls `createJob(ctx, type, input)` directly. Provider
jobs **must** set `input.provider` or `queueName(input)` throws. Never add an inline chat
call here — enqueue and return `202`.

### 7. Consume the output
A completed job's output has to be applied by something (a fold/apply service, a store write,
a status transition). Wire that where the result is awaited or where the job completion is
handled — otherwise the work runs and vanishes.

## Validate

```bash
npm run build                       # the JobType union + definitions record catch omissions
npm test -w @magpie/jobs            # catalog.test.ts + schemas.test.ts
npm run typecheck && npm run lint
```

Add/extend a `catalog.test.ts` case for the new routing and a `schemas.test.ts` case for the
payload. For end-to-end queue behaviour see the **`writing-magpie-tests`** skill (the
Postgres-backed broker integration test and `scripts/e2e-jobs.ts`).

## Gotchas

- **`JobType` is a closed union.** Adding to `JOB_TYPES` cascades compile errors through the
  `definitions` record and every exhaustive switch — that's the design working; fix each,
  don't cast around it. (No `unknown`/`any` casts — project non-negotiable.)
- **`AI_JOB_TYPES` is a second list to keep in sync.** A provider job missing from it won't
  be counted by the in-flight AI cap; a non-AI job wrongly added fails the `satisfies` check.
- **Never hardcode a queue name.** `type` vs `type__capability` (dashes→underscores) lives
  only in `partitionedQueueName` in the catalog. Ask the definition:
  `queueNameForJob(type, input)`.
- **Advertised-vs-executable invariant.** If `capabilities.ts` says a capability is ready but
  `runners/index.ts` builds no runner for it (or vice versa), the watcher claims jobs it
  can't run, or ignores jobs it could. There is deliberately no `mock` runner.
- **Provider jobs with no `input.provider`** throw at enqueue (`requiredCapability`), not at
  run time. The API's ask service picks the configured provider before enqueuing.
- New docs: if the job is user-visible or changes the model, update `docs/ai-jobs.md` /
  `docs/architecture.md` alongside the code.
- **A maintenance *orchestrator* self-starves a single watcher.** The maintenance pattern is:
  the watcher claims the job and POSTs a thin API endpoint, and the API `runJobToCompletion`s
  the real generative work as *enqueued* AI jobs (`verify_gap_closure`, the patrols, the gap
  reconciler all do this). The claiming watcher **blocks inside that POST** for the whole
  orchestration, and a watcher runs **one job at a time** — so the inner AI jobs can only be
  claimed by a *second* watcher. With one watcher they never get claimed and time out. If you
  add or touch such a job, it **requires ≥2 watchers** (say so in docs; `run-magpie` starts
  two, and the console warns at one). This is a real trap — it bit `verify_gap_closure` (#150).
- **An orchestrator timeout is not a result.** `runJobToCompletion` does **not** throw when its
  bounded wait elapses — it cancels the job and returns a non-`completed` `JobView` (state
  `cancelled`/`failed`). Check `job.state === "completed"` before reading `job.output`; treating
  a timed-out/empty output as a *content* verdict silently converts an infrastructure outage
  (no watcher free) into a wrong answer. Fail/retry the orchestrator instead so its own retry
  budget absorbs the outage (see `verifyGapClosure` throwing `VerificationIncompleteError` →
  `503`). To exercise this in a test, a plain `FakeJobBroker` leaves the enqueued job in
  `created` so the bounded wait (`JOB_RUN_TO_COMPLETION_TIMEOUT_MS`, 100ms in the test context)
  times out and cancels it.
