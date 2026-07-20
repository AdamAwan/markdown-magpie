# AI Job Contract & Capability Model

> **Status:** living spec (as-built). Source of truth for how Markdown Magpie represents
> generative AI work as queued jobs, how watchers claim and complete them by capability,
> and the completion/usage/repair contract around a job. Follows the
> [spec conventions](./README.md#conventions).

## Purpose

Keep every *chat*/generative model call out of the request path and behind a durable queue,
so Markdown Magpie can drive hosted model APIs or local CLI tools (Codex, Claude Code)
interchangeably, survive restarts, meter and price spend, and never pay twice for the same
generation. The API enqueues typed jobs onto a pg-boss queue in Postgres; a capability-matched
watcher claims one, runs a provider, and posts a validated result back. Embeddings are the
sole inline exception. The domain *workflows* that enqueue these jobs live in their own
specs — retrieval ([retrieval.md](./retrieval.md)), gaps/patrols/reconciler
([gaps-and-maintenance.md](./gaps-and-maintenance.md)), proposals/publishing, seeding — this
spec owns the **contract** they all share.

## Boundaries & execution model

- **J1** — The API MUST NOT call a *chat*/generative model inline. All generative work is
  represented as a job: the API enqueues, a watcher claims and completes it. Every
  job-backed endpoint returns **202** with the created job, never a synchronous generation.
- **J2** — **Embeddings are the sanctioned inline exception.** The API holds an embedding
  provider and computes embeddings synchronously for indexing and for query-time retrieval,
  routing, and gap clustering. There is no `embed_*` job type; embeddings are configured
  separately from the chat provider (OpenAI-compatible or Azure embedding endpoints).
- **J3** — The watcher has **no database access**. It talks to the API only: claim a job,
  run a provider adapter, complete or fail, poll again — one job at a time. This keeps
  Codex, Claude Code, and hosted APIs behind the same contract.
- **J4** — Jobs and schedules are owned entirely by **pg-boss** (the `JobBroker`), which
  manages its own Postgres tables, claiming, retries, and overlap protection so multiple
  watchers can safely poll the same queues. The legacy custom job table and its
  queue-selection override are removed. Storage backend is `STORAGE_BACKEND=postgres`.

## Job states

- **J5** — A job moves through pg-boss states: `created` → `active` → `completed`
  (terminal). Other states: `retry` (queued for another attempt after a recoverable
  failure), `failed` (terminal, retries exhausted, dead-lettered), `cancelled` (terminal,
  operator-cancelled), and `blocked` (waiting on a dependency / singleton key — surfaced
  when pg-boss marks a `created`/`retry` row `blocked`). `JobView.output` is populated only
  in the `completed` state; `error` only in `retry`/`failed`.

## Client flow

- **J6** — The standard request/await pattern for any job-backed endpoint is: (1) `POST` the
  work → **202** with the created job and links; (2) `GET /api/jobs/:id/wait` long-polls,
  returning **200** once the job is terminal or **202** if still running (re-issue to keep
  waiting; `JOB_WAIT_TIMEOUT_MS` bounds each call, `JOB_WAIT_POLL_MS` the server poll
  cadence); (3) `GET /api/jobs/:id` fetches a snapshot at any time without blocking.

## The job catalog

- **J7** — The job catalog (`packages/jobs/src/catalog.ts`, keyed to `JOB_TYPES` in
  `types.ts`) is the **single source of truth** for every job type's input/output schema,
  routing capability, queue name, policy, and repairability. Nothing outside the catalog may
  hand-maintain a parallel list of job types, queues, or capabilities. Input/output shapes
  live in `packages/jobs/src/schemas.ts` and MUST validate at enqueue (J20) and at
  completion (J24).
- **J8** — Each type routes one of three ways: a **bare capability** (one statically-named
  queue), **`provider`** (fans out over the four AI providers, keyed off `input.provider`,
  metered), or a **fan-out spec** (fans out over an explicit capability set keyed off an
  input field, with an optional default). The concrete queue name is `type` for a
  single-capability job and `type__capability` (dashes → underscores) when it fans out;
  every work queue also provisions a `__dead_letter` sibling.

| Job type | Routing | Expiry | Runner | Metered (AI) | Interactive | Repairable |
| --- | --- | --- | --- | --- | --- | --- |
| `answer_question` | provider | 5 min | generative (chat/CLI) | ✓ | ✓ | ✓ |
| `answer_question_batch` | provider | 5 min | generative (chat/CLI) | ✓ | — | ✓ |
| `summarize_gap` | provider | 10 min | generative | ✓ | — | ✓ |
| `draft_markdown_proposal` | provider | 15 min | source-grounded | ✓ | — | — |
| `draft_seed_document` | provider | 15 min | source-grounded | ✓ | — | — |
| `outline_flow_seed` | provider | 10 min | source-grounded | ✓ | ✓ | ✓ |
| `revise_seed_plan` | provider | 10 min | generative | ✓ | — | ✓ |
| `fold_markdown_proposal` | provider | 15 min | generative | ✓ | — | — |
| `detect_contradiction` | provider | 10 min | generative | ✓ | — | ✓ |
| `suggest_consolidation` | provider | 10 min | generative | ✓ | — | ✓ |
| `reconcile_gap_clusters` | provider | 5 min | generative | ✓ | — | ✓ |
| `sync_source_changes_generate_plan` | provider | 60 min | source-grounded | ✓ | — | — |
| `verify_document` | provider | 15 min | source-grounded | ✓ | — | — |
| `correct_document` | provider | 15 min | source-grounded | ✓ | — | — |
| `dedupe_documents` | provider | 10 min | generative | ✓ | — | — |
| `split_document` | provider | 10 min | generative | ✓ | — | — |
| `improve_document` | provider | 15 min | source-grounded | ✓ | — | — |
| `fold_changeset_proposal` | provider | 15 min | generative | ✓ | — | — |
| `refresh_flow_snapshot` | github | 5 min | refresh-snapshot | — | — | — |
| `process_gaps_to_pull_requests` | maintenance | 60 min | maintenance | — | — | — |
| `source_change_sync` | maintenance | 60 min | maintenance | — | — | — |
| `correctness_patrol` | maintenance | 60 min | maintenance | — | — | — |
| `editorial_patrol` | maintenance | 60 min | maintenance | — | — | — |
| `verify_gap_closure` | maintenance | 60 min | maintenance | — | — | — |
| `seed_bootstrap` | maintenance | 60 min | maintenance | — | — | — |
| `publish_proposal` | {github, local-git} by `destination` | 15 min | publication | — | — | — |
| `crosslink_pull_requests` | github | 10 min | publication | — | — | — |
| `comment_pull_request` | github | 10 min | publication | — | — | — |

- **J9** — `AI_JOB_TYPES` (the 18 `provider`-routed rows above) is the metered set: every
  type whose work is a chat/generative provider call. `isAiJobType` reads it so cost
  controls can count in-flight AI work without re-deriving the list.
- **J10** — **Interactive class.** `INTERACTIVE_AI_JOB_TYPES = {answer_question,
  outline_flow_seed}` names the AI jobs a live caller is waiting on right now (a `/api/ask`
  answer — including a `verify_gap_closure` re-ask a blocked orchestrator bounded-waits on —
  and a console flow outline). `answer_question_batch` (questionnaire drip) shares the answer
  contract but is **deliberately not interactive**, so a bulk questionnaire can never erode
  the interactive reserve protecting `/api/ask`. This split drives the claim-side lane order
  (J17) and the AI capacity gate's interactive reserve (see
  [rate-limiting.md](./rate-limiting.md)).
- **J11** — **Retry budget** (per `catalog.ts` `policy`): interactive provider AI keeps
  `retryLimit 3` (a live caller is waiting; a transient blip should not surface as a hard
  fail); maintenance/non-interactive provider AI drops to `2` so a runaway patrol cannot
  triple its metered generations on retries; non-provider work is `2`. Provider work uses
  `retryDelay 15 / retryDelayMax 300`; non-provider `30 / 600`. All queues share
  `heartbeatSeconds 60`, `retentionSeconds 14d`, `deleteAfterSeconds 30d`, `retryBackoff`.

## Capabilities & routing

- **J12** — A watcher advertises a **capability** for each provider whose credentials are
  present in its environment, plus `maintenance` (always available). The runner factory
  consults the **same readiness gates** as the advertisement, so a capability is advertised
  on claim if and only if a runner can actually execute it — there is deliberately no `mock`
  capability. Secrets are tested only for presence, never logged.

| Capability | Required env |
| --- | --- |
| `openai-compatible` | `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL` |
| `azure-openai` | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_CHAT_DEPLOYMENT` |
| `codex` | `CODEX_CLI_PATH` (defaults to `codex` on `PATH`) |
| `claude` | `CLAUDE_CLI_PATH` (defaults to `claude` on `PATH`) |
| `local-git` | `MAGPIE_GIT_AUTHOR_NAME`, `MAGPIE_GIT_AUTHOR_EMAIL` (git on `PATH`; **no** token) |
| `github` | `GITHUB_TOKEN`, `MAGPIE_GIT_AUTHOR_NAME`, `MAGPIE_GIT_AUTHOR_EMAIL` (git on `PATH`) |
| `maintenance` | (none) |

- **J13** — The API MUST route a job only to a capability a running watcher actually offers,
  so a job stays queued until a capable watcher exists. The console's coverage banner is
  driven from `jobTypesWithoutCapabilities` (a type is covered if **any** of its
  capabilities is available), so it can never drift from the catalog.
- **J14** — `AI_PROVIDER` is mandatory on a watcher and names the single chat provider its
  work routes to (`openai-compatible`, `azure-openai`, `codex`, or `claude`); the watcher
  MUST carry the matching credentials. CLI providers cover the whole non-embedding LLM job
  contract; embeddings remain configured separately (J2).
- **J15** — `publish_proposal` fans out over `{github, local-git}` by `input.destination`: a
  `file://` destination routes to `publish_proposal__local_git` (branch push only — a
  token-less watcher serves it, and the console's Accept/merge takes over), anything else to
  `publish_proposal__github` (push **and** open a PR). Enqueues omitting `destination`
  default to `github` (legacy-compatible). A `github`-credentialed watcher also satisfies
  `local-git` (it has git + author), so it publishes to both. Publishing and its status
  lifecycle are specified in proposals-and-publishing (see [architecture.md](./architecture.md)).
- **J16** — Runner ↔ job-type support is derived, not hand-mapped: the chat and CLI runners
  support exactly `PROVIDER_JOB_TYPES` (derived from the catalog), the maintenance runner
  the six `maintenance` orchestrators, the publication runner `publish_proposal` +
  `crosslink_pull_requests` + `comment_pull_request`, and the refresh runner
  `refresh_flow_snapshot`. The worker loop fails a job loudly if no runner supports its type.

## Claiming

- **J17** — On claim, the broker probes the worker's **interactive** queues (J10) first —
  in fixed order — so a freed watcher picks up an `answer_question` ahead of patrol fan-out
  enqueued earlier (#240). Only then does it serve **background** queues **round-robin,
  oldest-first within a queue**, advancing a fairness cursor so no single busy queue (e.g. a
  patrol's `verify_document` fan-out) starves its siblings. `POST /api/jobs/claim` carries
  `{workerName, capabilities}` and returns `{job}` or `{job: null}`.

## Completion contract — a generation is never re-billed (#161)

A provider generation is the expensive part of a job; everything after it (question-log
updates, drafting a proposal row, fold reconciliation, source-sync plan attachment) is cheap,
idempotent bookkeeping keyed on the job id. Two failure points used to throw a finished,
paid-for generation away and force pg-boss to redo the whole job; both are closed:

- **J18** — **`completeJob` persists first, fans out second.** The validated output is saved
  via the broker's `complete()` *before* any side effect runs. pg-boss's `fail()` only ever
  retries a job that has not reached `completed`, and its `complete()` is a no-op on one that
  has — so once persistence succeeds, nothing downstream can trigger a regeneration. A
  side-effect failure is logged and the endpoint replies **500 `side_effects_failed`**, but
  the job is **not** failed: it did complete.
- **J19** — **Side effects are self-healing on replay.** Every side-effect handler is
  idempotent on jobId, so a retried completion POST hits the **replay branch**: `completeJob`
  detects the job is already `completed` and re-runs only the fan-out from the persisted
  `{result, executor}` envelope, without requiring or re-validating a fresh body. That 500
  can never re-bill the generation — the replay path never reaches the provider.
- **J20** — Enqueue-time validation: `createJob` validates `input` against the job's own
  contract before persisting (#285), so a `manage:jobs` caller cannot dispatch a malformed
  input (e.g. a source descriptor smuggling an executable). The pg-boss broker re-validates
  on the single typed `enqueue` path shared by `create` and `createIfAdmitted`.
- **J21** — **The watcher retries `complete()` itself.** `HttpWatcherApi.complete()` retries
  a failed completion POST a few times with backoff for a **network error or 5xx** only — a
  `4xx` (e.g. `invalid_output`, `job_not_found`) is a deterministic contract failure retries
  cannot fix and falls straight through to `api.fail()`. Composed with J18–J19 this yields
  self-healing side effects; if the retries exhaust, `api.fail()` is a harmless no-op on the
  completed row, so the output survives and a later manual re-POST of `/complete` can still
  replay the bookkeeping.
- **J22** — **Reading a completed job's output back (#184).** Because the persisted output is
  the `{result, executor, usage?, provider?, model?}` envelope, any API-side consumer of
  `runJobToCompletion` MUST parse it through `parseCompletedJobOutput(schema, job.output)`,
  never run the raw output schema against `JobView.output` directly — the raw parse only
  succeeds against envelope-less test fakes and silently discards real watcher results. Gap
  reshape, the patrol verify lens, and gap-closure re-asks all read through this helper.

## Token usage, execution identity & cost (#241)

- **J23** — **Usage rides the completion envelope.** Runners report each provider call's
  token usage through an optional `onUsage` callback (the chat runner wraps its provider in
  `withUsageReporting`; the source-agent loop reports `generateText`'s aggregate
  `totalUsage`), the worker loop sums the readings, and `complete()` sends the total. The API
  persists it beside the output as `{result, executor, usage}` — on the **envelope**, not the
  job's own output, so it can never collide with schema-stripping. CLI providers emit raw
  text and report nothing, so their completions carry **no** usage (unmetered, not zero).
- **J24** — **Valid output strips undeclared keys, never fails on them.** Output schemas are
  `z.object`, so a valid parse strips fields the contract does not declare; the strip is
  logged (never a failure) so a watcher shipping extra fields is observable.
- **J25** — **Execution identity rides the envelope too.** Each AI runner exposes an
  `aiIdentity` — its provider plus the *configured* model (chat model / Azure deployment /
  CLI `--model`) — and the worker loop stamps flat `provider`/`model` envelope fields on
  every completion. A CLI runner with no explicit model reports only its provider (it ran on
  its own default). This is what lets usage rollups price spend against the operator's
  `AI_PRICING` table; a malformed value is dropped by the body schema, never a 400.
- **J26** — **Cost is priced at read time, never persisted.** Insights rollups turn stored
  `usage` × the identity's model into money via `estimateTokenCost` each time they are read,
  so correcting a mispriced entry retroactively re-values history. Three states stay distinct
  and never render as `$0`: **priced**, **unpriced** (usage reported, no matching price), and
  **unmetered** (no usage — the CLI case). Consumed by the C11 AI-usage chart and the
  per-flow / per-schedule cost views ([insights-charts.md](./insights-charts.md)).
- **J27** — **`flowId` on the input attributes spend (attribution only).** Per-flow and
  per-schedule cost rollups read the flow off the stored job input at
  `data->'input'->>'flowId'`. Most flow-scoped AI jobs carry it; `verify_document` and
  `draft_markdown_proposal` were extended to carry it for the patrol and reconciler.
  `answer_question` and the `fold_*` jobs carry no flowId, so their spend is unattributed in
  the per-flow view and excluded from per-schedule attribution. The field is metadata the
  runners ignore.

## Schema-invalid output & one informed repair (#288d)

- **J28** — When completion output fails its contract, the job takes one of two paths per
  `decideRepairOrTerminal`: (a) a **repairable** type with repair enabled and no prior repair
  context is offered **one** informed repair; (b) everything else takes the **terminal-fail
  backstop** — no more blind, paid retries.
- **J29** — **The repair path** persists a `JobRepairContext` (`{attempt: 1, priorOutput,
  issues}`) in a store keyed by job id — never in the domain input schema — then plain
  `fail()`s so pg-boss moves the **same** job `active → retry`. It is **not** routed through
  admission control: the job already holds the capacity slot its original admission reserved,
  so re-admitting would double-charge or 429 mid-repair. On re-claim, `claimJob` attaches the
  context to the `JobView`; the chat/CLI runner sees `job.repair` and runs a **single-shot
  reshape** of `priorOutput` against the contract (`runRepairReprompt` — no retrieval, no
  agent loop) via the `REPAIR_OUTPUT` prompt. Repair-of-a-repair is structurally impossible
  (a second invalid output finds a prior context and terminal-fails).
- **J30** — **Repairable types** are the reshape-style ones that rework material already in
  the input/prior output with no risk of fabricating grounded content: `answer_question`,
  `answer_question_batch`, `summarize_gap`, `detect_contradiction`, `suggest_consolidation`,
  `reconcile_gap_clusters`, `outline_flow_seed`, `revise_seed_plan`. Source-grounded /
  agentic / patch-emitting types are deliberately **not** repairable (a context-free reshape
  could invent grounding or an `observedSha`). `isRepairableJobType` reads the catalog so the
  set never drifts.
- **J31** — A repaired answer-contract output MUST pass a **safety guard** before completing:
  its citation `sectionId`s must be a **subset** of the prior output's (drop/keep allowed,
  never add), because citations are derived in code from retrieved sections and must never be
  model-fabricated. A guard failure terminal-fails.
- **J32** — **The terminal-fail backstop** (`failTerminal`) zeroes the one row's
  `retry_limit` via a scoped `UPDATE` (pg-boss self-guards `updateJob` to non-active rows, so
  the raw SQL is required to touch the active row), then `fail()`s — pg-boss routes it to
  terminal `failed` + dead-letter. `failTerminal` no-ops on an already-terminal row,
  protecting the completion-replay contract (J19).
  > ⚠️ **Drift corrected (as-built).** An earlier version of this doc stated schema-invalid
  > output "still fails the job through the normal retry budget" and that a "repair reprompt
  > would fix this properly but is out of scope here." That is now **stale**: the informed
  > repair (#288d, J28–J32) is implemented and gated by `settings.jobs.repairEnabled`. The
  > only unchanged case is a **non-repairable** type or a **second** invalid output, which
  > takes the terminal-fail backstop instead of the old blind retry budget.

## HTTP endpoints

- **J33** — Operator/console surface (`manage:jobs` unless noted): `POST /api/jobs` (create
  → 202 `{job}`); `GET /api/jobs` (list, filter by `type`/`state`/`createdAfter`,
  `limit`/`offset`, scope `read:knowledge`); `GET /api/jobs/:id`, `GET /api/jobs/:id/wait`
  (scope `read:knowledge`, 200/202 per J6); `GET /api/jobs/schedules` (registered pg-boss
  crons); `POST /api/jobs/:id/cancel` (terminal); `POST /api/jobs/:id/retry` (409
  `job_not_failed` unless the job is `failed`); `POST /api/jobs/:id/accept-failure`
  (acknowledge a failure without changing queue state — it stays inspectable/retryable but
  stops warning).
- **J34** — Watcher-only surface (operators rarely call directly): `POST /api/jobs/claim`
  (J17); `POST /api/jobs/:id/heartbeat` (keep a claim alive; the response flags `cancelled`
  so the runner aborts); `POST /api/jobs/:id/complete` (`{output, executor, usage?,
  provider?, model?}` → the envelope of J18–J25; 500 `side_effects_failed`, 404
  `job_not_found`, 409 `job_cancelled`, 400 `invalid_output`/`repair_enqueued`); `POST
  /api/jobs/:id/fail` (a structured `{error: {code, message, category}}`).
- **J35** — Answer-path callbacks the watcher makes while running `answer_question`:
  `POST /api/retrieve` (scoped context for a flow) and `POST /api/route` (embedding-similarity
  flow pick, abstaining on a low margin so the watcher falls back to the chat router). Both
  keep embeddings/retrieval **inside the API** — the watcher is HTTP-only. Specified in
  [retrieval.md](./retrieval.md).

## Watcher runtime & CLI isolation

- **J36** — The worker loop runs **one job at a time**: claim → dispatch to the supporting
  runner under an `AbortController` → heartbeat on half the job's window (aborting the runner
  if the server reports the job cancelled) → report the single terminal outcome (complete or
  fail). A claim/transition error is logged and backed off, never crashes the process; a
  server-side cancellation is not re-reported as a failure. The job runs inside a span
  parented on the enqueueing request's `traceContext` carried across the queue.
- **J37** — **CLI environment isolation.** A local agent CLI boots as a full interactive
  assistant by default (its own persona, full toolset, and whatever MCP servers, settings,
  hooks, and `CLAUDE.md`/`AGENTS.md` the environment or cwd carries). The runner assembles
  isolation args **in code** (`runners/cli.ts`), **after** the operator-configured
  `*_CLI_ARGS`, so configuration cannot drop them:
  - **One-shot generative runs** execute in a neutral working directory (OS temp dir) with,
    for claude, `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, and a
    `--system-prompt` carrying the job-runner instructions (replacing the interactive
    persona); codex gets `--sandbox read-only --skip-git-repo-check` and keeps its folded
    `SYSTEM:` block (no system-prompt flag).
  - **Source-grounded runs** keep a read-only explore toolset (claude: `--tools Read,Grep,Glob`
    plus disallowed write tools; codex: `--sandbox read-only`) and also run from a **neutral
    cwd**, never an untrusted checkout — the memory-file neutralisation. Checkouts are reached
    read-only via repeated `--add-dir` (claude, a tool-access root not a memory root) or the
    prompt path list (codex). claude also gets `--strict-mcp-config`, `--setting-sources ""`,
    and the `--system-prompt`.
  - **Minimal child environment.** Every spawn passes an explicit `env` allowlist instead of
    inheriting the watcher's full `process.env`: non-secret operational vars plus only the
    calling CLI's own credential (`ANTHROPIC_*`/`CLAUDE_CONFIG_DIR` for claude;
    `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`CODEX_HOME` for codex, matched by exact name so a
    different provider's key is never swept in). `MAGPIE_CLI_ENV_PASSTHROUGH` forwards extra
    named vars without a code change.
- **J38** — Defence in depth on the answer side: an `answer_question` reply that ignores the
  structured JSON contract (plain prose) is always grounding-verified despite its low
  confidence and **fails closed** — if the verifier cannot vouch for the prose, the safe
  fallback answer ships instead of the raw text.
- **J39** — **Prompt mode.** `*_CLI_PROMPT_MODE` is `arg` (append the prompt as the final
  process argument) or `stdin` (send it on standard input). The agent MUST return JSON
  matching the job's output schema; the watcher extracts and validates JSON before completing.
- **J40** — **Provider adapters (`AgentRunner`).** Provider support stays behind adapters
  that normalise every provider to the same internal job contract, keep prompts and output
  schemas provider-neutral, validate provider output before completing, prefer OpenAI-compatible
  `/chat/completions` for broad coverage, keep credentials in env (never in job payloads),
  bound external calls with timeouts, and fail with readable errors. One conformance smoke
  test per provider shape (answer, gap summary, proposal).

## Source-grounded jobs & their I/O

- **J41** — The **source-grounded** job set — `draft_markdown_proposal`, `draft_seed_document`,
  `outline_flow_seed`, `verify_document`, `correct_document`, `improve_document` (and the
  source-sync plan job) — carries `sources: SourceDescriptor[]` (references to the flow's
  configured sources, projected at enqueue time), **never** inline file content. The watcher
  resolves git/local descriptors to **read-only workspaces** on the shared checkout volume;
  the executing agent explores them directly — CLI providers (`codex`, `claude`) traverse the
  checkout with their own tools under the in-code read-only enforcement (J37); HTTP providers
  (`openai-compatible`, `azure-openai`) run the bounded `list_dir`/`read_file`/`grep` tool
  loop — under `MAGPIE_AGENTIC_TIMEOUT_MS` (default 600 000 ms; queues expire at 900 s for
  headroom). A job whose filesystem sources all fail to resolve fails loudly. `dedupe_documents`
  and `split_document` are **not** source-grounded (they compare a doc against its
  destination neighbours). A job with no filesystem-backed and no fetchable source runs the
  plain one-shot generative path. Full detail:
  [source-agentic grounding design](superpowers/specs/2026-07-06-source-agentic-grounding-design.md).
- **J42** — `agent` sources render as reference-only prompt notes; `internet` sources do too
  **unless** the operator opted the descriptor into fetching with a non-empty `allowedHosts`
  allowlist (#242). HTTP providers then get a `fetch_url` tool (https only, exact-hostname
  allowlist re-checked per redirect, text-only, 2 MB cap, HTML→text, 32 KB slices on the same
  400 KB read budget as `read_file`, every retrieval logged); claude CLI additionally gets
  `WebFetch` with one `WebFetch(domain:<host>)` rule per allowlisted host; codex CLI **cannot
  fetch** (its read-only OS sandbox blocks network), so those sources degrade to reference
  notes. Fetched web content is untrusted input to the drafting agent — the allowlist, fetch
  logging, and human merge review are the controls ([threat-model.md](./threat-model.md)).
- **J43** — **Register constraint (#213).** Every content-producing prompt (gap drafts, seed
  drafts, both folds, source-sync rewrites, corrective rewrites, improve growth) carries a
  shared factual-register contract: documents state what the sources state and never author
  their own recommendations, next steps, action items, roadmaps, or editorial commentary
  (describing a plan a *source itself* states remains allowed). Unsupported points are omitted
  from the body and returned in the output's optional `uncoveredPoints`, which the API folds
  into the proposal rationale. As a backstop the API runs an advisory-heading check
  (`findAdvisoryHeadings`) over every draft/rewrite/fold output it consumes: an advisory
  heading is **flagged, never failed** (a log warning + a "Register check:" rationale note).
  The two fold appliers check log-only; `dedupe_documents`/`split_document` are not checked
  (they reorganise existing content).
- **J44** — **Per-claim provenance (#214).** Both draft outputs
  (`draft_markdown_proposal`, `draft_seed_document`) include an optional
  `provenance: ProvenanceClaim[]` — each substantive claim with the source id + repo-relative
  path(s) that ground it. The document **body contains no repository paths or source names**
  (inline citations leaked into served answers); citations live only in the structured field.
  The API persists it on the proposal (`proposals.provenance`, migration 0049) with event-log
  semantics. `correct_document` and the `improved: true` branch of `improve_document` carry
  the same field (the claims their rewrite introduces/changes); `fold_markdown_proposal`
  receives both parents' provenance and returns the re-anchored merged set.
  `verify_document` additionally accepts an optional `citedClaims: ProvenanceClaim[]` folded
  from a document's merged proposals, dropping claims whose section anchor no longer exists
  (falling back to full re-derivation). A draft that omits provenance is warned about but
  still published — quality is enforced by review, never by rejecting drafts.
  `dedupe_documents`/`split_document` changesets carry no per-claim provenance by design.

## Source map (agent navigation hints)

- **J45** — The source map is a per-source store of topic-indexed navigation hints
  maintained by the agents themselves, unique on `(source_id, topic)`, strictly **internal
  metadata** that never enters answer retrieval, user-facing output, or the indexed KB.
- **J46** — **Read path.** At workspace preparation for any source-grounded job the watcher
  fetches `GET /api/source-map?sourceIds=…` (scope `manage:jobs`; comma-separated ids; the
  ≤100 most-recently-updated entries per source, capped 100 reads per source per request; 400
  on missing/malformed `sourceIds`) and renders the hints to the prompt as **unverified**,
  framed as updatable. The fetch is best-effort — rendered only for sources that respond, and
  the job never fails on a timeout/partial result.
- **J47** — **Write path.** The six source-grounded job types accept an optional `mapUpdates`
  output field (`{sourceId, topic (≤120), paths (≤8, each ≤260), description (≤240),
  observedSha?}`). The completion dispatcher applies them best-effort: upsert by
  `(source_id, topic)`, capped 20 per job (excess dropped with a warning), per-source cap 200
  with oldest-updated eviction; malformed updates are dropped with a structured warning and
  never fail the job.
- **J48** — `observed_sha` is always the checkout HEAD stamped by the watcher during
  workspace preparation, **never** trusted from the model (agent-supplied values are
  overwritten; null for non-git sources). The generative fallback path stamps against an
  **empty** workspace set, which strips `observedSha` from every update, so a job that never
  observed a checkout cannot smuggle one. Each entry also carries a `consensusCount`
  (credibility): on upsert, Jaccard overlap of paths > 0.5 increments (capped 5), ≤ 0.5 (or
  first-seen) resets to 1; computed atomically under a row lock.

## Key constants

| Constant | Default | Where |
| --- | --- | --- |
| `MAGPIE_AGENTIC_TIMEOUT_MS` | 600 000 ms (10 min) | `apps/watcher/src/runners/index.ts` |
| `AGENT_API_TIMEOUT_MS` / `AGENT_CLI_TIMEOUT_MS` | 120 000 ms | `apps/watcher/src/runners/index.ts` |
| default heartbeat interval | 30 000 ms (half the 60 s policy) | `apps/watcher/src/worker-loop.ts` |
| queue `heartbeatSeconds` | 60 | `packages/jobs/src/catalog.ts` (`BASE_POLICY`) |
| interactive vs maintenance `retryLimit` | 3 vs 2 | `packages/jobs/src/catalog.ts` (`policy`) |
| `AI_ADMISSION_LOCK_KEY` | fixed advisory key | `apps/api/src/jobs/pg-boss-broker.ts` |
| `LOCATE_CONCURRENCY` | 8 | `apps/api/src/jobs/pg-boss-broker.ts` |

## Code map

| Concern | Code |
| --- | --- |
| Job contract (types, catalog, I/O schemas) | `packages/jobs/src/{types,catalog,schemas}.ts` |
| pg-boss broker (enqueue, claim, complete/fail, dead-letter, admission) | `apps/api/src/jobs/{broker,pg-boss-broker}.ts`, fake: `apps/api/src/jobs/fake-broker.ts` |
| Schedule reconciliation | `apps/api/src/jobs/schedule-reconciler.ts` |
| Jobs feature (routes, persist-first complete, replay, repair, `parseCompletedJobOutput`) | `apps/api/src/features/jobs/{routes,service,schema}.ts` |
| AI capacity gate (interactive reserve) | `apps/api/src/platform/ai-capacity.ts` (see [rate-limiting.md](./rate-limiting.md)) |
| Cost pricing (read-time) | `apps/api/src/platform/ai-pricing.ts` |
| Worker loop (claim/execute/heartbeat/usage) | `apps/watcher/src/worker-loop.ts`, `apps/watcher/src/usage.ts` |
| Runner factory + capability gates | `apps/watcher/src/runners/index.ts`, `apps/watcher/src/capabilities.ts` |
| Chat / CLI runners + isolation | `apps/watcher/src/runners/{chat,cli}.ts` |
| Generative loop, repair reshape | `apps/watcher/src/runners/{generative,repair}.ts`, `apps/watcher/src/job-prompts.ts` |
| Source-grounded agent + workspaces + fetch | `apps/watcher/src/runners/source-agent.ts`, `apps/watcher/src/{source-workspace,source-tools,fetch-url}.ts` |
| Maintenance / publication / refresh runners | `apps/watcher/src/runners/{maintenance,publication,refresh-flow-snapshot}.ts` |
| Watcher HTTP client (complete retry) | `apps/watcher/src/http-client.ts` |
| Source-map store + route | `apps/api/src/features/source-map/routes.ts`, `apps/api/src/stores/{source-map-store,postgres-source-map-store,source-map-consensus}.ts` |

## Tests (behavioural contract)

`packages/jobs/src/{catalog,schemas}.test.ts`,
`apps/api/src/jobs/{fake-broker,pg-boss-broker,pg-boss-broker.integration,schedule-reconciler}.test.ts`,
`apps/api/src/features/jobs/{routes,service,fold-dispatch}.test.ts`,
`apps/watcher/src/{worker-loop,capabilities,config,http-client,usage,job-prompts,source-tools,source-workspace,fetch-url,health-server}.test.ts`,
`apps/watcher/src/runners/{chat,cli,generative,maintenance,publication,publication-comment,publication-crosslink,refresh-flow-snapshot,repair,source-agent}.test.ts`,
`apps/api/src/features/source-map/routes.test.ts`,
`apps/api/src/stores/{source-map-store,postgres-source-map-store}.test.ts`.

## Provenance (design history)

Consolidates, and supersedes as a behavioural description:
`docs/superpowers/specs/2026-06-19-queue-only-pg-boss-design.md` (the queue-only pg-boss
model — the API stops running AI inline and watchers claim by capability),
`2026-06-22-jobs-knowledge-layout-design.md` and `2026-06-22-jobs-separate-panels-design.md`
(the Jobs console surface),
`2026-06-23-watcher-git-readiness-and-checkout-design.md` and
`2026-07-01-watcher-startup-config-validation-design.md` (capability readiness gates and
watcher startup validation),
`2026-07-03-local-git-publish-and-watcher-coverage-banner-design.md` (the `local-git`
publish capability, `publish_proposal` fan-out, and coverage banner),
`2026-07-06-source-agentic-grounding-design.md` (source-grounded workspaces, the tool loop,
`mapUpdates`, and `#242` internet fetching),
`2026-07-15-ai-cost-chart-redesign-design.md` (`#241` usage/identity envelope and read-time
pricing). The completion re-billing fix (`#161`/`#184`/`#241`), the interactive claim lane
(`#240`), and the informed-repair contract (`#288d`) are as-built in code (J18–J32) ahead of
a dedicated design record; the earlier "repair reprompt is out of scope" note is superseded
(see the J32 drift marker).
