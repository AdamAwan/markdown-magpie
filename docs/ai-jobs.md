# AI Job Contract

Generative (chat) AI work is represented as jobs on a pg-boss queue in Postgres so
Markdown Magpie can use hosted model APIs or external tools such as Codex and Claude
Code. The API enqueues these jobs; a watcher claims and completes them. The API never
runs a *chat* model inline.

Embeddings are the exception: the API computes them inline (it holds an embedding
provider) for both indexing and query-time retrieval — they are not watcher jobs. See
the note on CLI providers below; embeddings are configured separately through
OpenAI-compatible or Azure embedding endpoints.

## Job states

A job moves through these states (mirroring pg-boss):

`created` → `active` → `completed` (terminal). Other states: `retry` (queued for
another attempt after a recoverable failure), `failed` (terminal, retries
exhausted), `cancelled` (terminal, cancelled by an operator), `blocked` (waiting
on a dependency / singleton key).

## Client flow

The standard request/await pattern for any job-backed endpoint:

1. `POST` the work — the API returns **`202`** with the created job and links.
2. `GET /api/jobs/:id/wait` — long-polls. Returns **`200`** once the job is
   terminal, or **`202`** if it is still running (re-issue the call to keep
   waiting; `JOB_WAIT_TIMEOUT_MS` bounds each call, `JOB_WAIT_POLL_MS` the
   server-side poll cadence).
3. `GET /api/jobs/:id` — fetch the job snapshot at any time without blocking.

## Endpoints

### `POST /api/jobs`

Creates a job. Returns `202` with `{ "job": JobView }`.

```json
{
  "type": "draft_markdown_proposal",
  "input": {
    "gapSummary": "No hotfix rollback procedure is documented",
    "triggeringQuestions": ["How do I rollback a hotfix?"],
    "evidence": [],
    "expectedOutput": "markdown_proposal"
  }
}
```

### `GET /api/jobs` / `GET /api/jobs/:id` / `GET /api/jobs/:id/wait`

List jobs (filter by `type`, `state`, `createdAfter`, with `limit`/`offset`),
fetch one, or block until one is terminal (see **Client flow** above).

### `GET /api/jobs/schedules`

Lists the registered pg-boss cron schedules.

### `POST /api/jobs/:id/cancel` / `POST /api/jobs/:id/retry`

Cancel a job (terminal), or retry a `failed` job (returns `409` if the job is
not in a failed state).

### `POST /api/jobs/:id/accept-failure`

Acknowledges a failed job without changing its queue state. Accepted failures remain
available for inspection and retry, but no longer trigger the console warning.

### Watcher-only endpoints

The watcher drives a job through these; operators rarely call them directly:

- `POST /api/jobs/claim` — claim the next claimable job matching the worker's
  capabilities: `{ "workerName": "local-dev-watcher", "capabilities": ["openai-compatible", "maintenance"] }`.
  Returns `{ "job": JobView }` or `{ "job": null }`. Queues holding
  **interactive-class** jobs (`INTERACTIVE_AI_JOB_TYPES`: `answer_question`,
  `outline_flow_seed` — a live caller is waiting) are offered before the
  background/maintenance queues, so an ask is never queued behind earlier patrol
  fan-out for a free watcher (#240); background queues are served round-robin,
  oldest-first within a queue.
- `POST /api/jobs/:id/heartbeat` — keep a long-running claim alive; the response
  flags `cancelled` so the watcher can abort.
- `POST /api/jobs/:id/complete` — `{ "output": { ... }, "executor": "..." }`.
- `POST /api/jobs/:id/fail` — a structured error:

```json
{
  "error": {
    "code": "provider_timeout",
    "message": "Provider timed out",
    "category": "timeout"
  }
}
```

- `POST /api/retrieve` / `POST /api/route` — answer-path callbacks the watcher makes
  while running an `answer_question` job: `retrieve` returns scoped context for a flow,
  and `route` cheaply picks the flow by embedding similarity (the API embeds the
  question + flow texts inline), abstaining on a low-margin score so the watcher falls
  back to the chat router. Both keep embeddings/retrieval inside the API — the watcher
  is HTTP-only. See [question-logging.md](./question-logging.md) → Queued Answers.
- `GET /api/source-map?sourceIds=…` — retrieve per-source navigation hints for the
  watcher at workspace preparation. Query parameter `sourceIds` accepts a comma-separated
  list of source IDs (e.g. `?sourceIds=agent,flowerbi`). Returns `{ "entries": SourceMapEntry[] }`,
  the ≤100 most-recently-updated entries per requested source (scope: `manage:jobs`,
  capped at 100 reads per requested source per request). Returns `400` if `sourceIds` is
  missing or malformed.

## Completion is never re-billed (#161)

A provider generation is the expensive part of a job; everything after it (question
log updates, drafting a `Proposal` row, fold reconciliation, source-sync plan
attachment, ...) is cheap, idempotent bookkeeping keyed on the job's id. Two failure
points used to throw a finished, paid-for generation away and force pg-boss to redo
the *entire* job:

- **API-side.** `completeJob` (`apps/api/src/features/jobs/service.ts`) used to run
  every side-effect handler *before* persisting the job's output. A side effect
  throwing (e.g. a transient DB error while drafting the proposal) landed in the
  catch-all, which called `ctx.jobs.fail(..., "completion_failed")` — since the job
  had never reached pg-boss's terminal `completed` state, that queued a full retry
  (`retryLimit: 3`, see `packages/jobs/src/catalog.ts`), redoing the provider call
  for output that already existed in memory.
- **Watcher-side.** `WorkerLoop.execute` (`apps/watcher/src/worker-loop.ts`) ran the
  provider call, then POSTed the result via `api.complete()`. If that single POST
  failed (a network blip, the API mid-restart), the catch fell straight through to
  `api.fail(..., "runner_failed")`, discarding the in-memory output the same way.

Both are fixed by making sure the job reaches `completed` (pg-boss's retry-proof
terminal state) as early and as reliably as possible, and by never treating a
failure *after* that point as a reason to redo the generation:

- **`completeJob` now persists first, fans out second.** The validated output is
  saved via `ctx.jobs.complete()` *before* any side effect runs. pg-boss's `fail()`
  only ever retries a job that hasn't reached `completed` (`state < 'completed'`),
  and its `complete()` is a no-op on a job that already has — so once persistence
  succeeds, nothing downstream can trigger a regeneration, no matter what fails
  next. A side-effect failure is logged (`logger.error`) and the endpoint replies
  **`500` with code `side_effects_failed`** — but the job is **not** failed: it did
  complete. Because every side-effect handler is idempotent on jobId, retrying the
  bookkeeping is just POSTing the same completion again — `completeJob` detects the
  job is already `completed` and replays the fan-out from the persisted
  `{ result, executor }` output instead of requiring (or re-validating) a fresh
  body. Crucially, that 500 cannot re-bill the generation: a retried POST hits the
  replay path, never the provider.
- **Token usage rides the completion envelope (#241).** Runners report each
  provider call's token usage through an optional `onUsage` callback (the chat
  runner wraps its provider in `withUsageReporting`; the source-agent loop
  reports `generateText`'s aggregate `totalUsage`), the worker loop sums the
  readings (`apps/watcher/src/usage.ts`), and `complete()` sends the total. The
  API persists it beside the output as `{ result, executor, usage }` — on the
  envelope, not the job's own output, so it can never collide with the
  job-contract schema-stripping — and the Insights **AI token usage** chart
  (C11) aggregates it per (job type, provider). Optional end to end: CLI
  providers emit raw text and report nothing, so their completions carry no
  usage at all (unmetered, not zero — the chart says which).
- **The execution identity rides the envelope too.** Each AI runner exposes an
  `aiIdentity` — its provider plus the *configured* model name (chat model /
  Azure deployment / CLI `--model`) — and the worker loop stamps it on every
  completion as flat `provider`/`model` envelope fields. Token counts alone
  cannot be priced retroactively (cost is a function of the model, which
  otherwise lives only in watcher env), so this is what lets usage rollups
  convert spend into money against the operator's `AI_PRICING` table (see
  `apps/api/src/platform/ai-pricing.ts`). A CLI runner with no explicit model
  configured reports only its provider — the CLI ran on its own default, and
  reporting nothing beats guessing. Best-effort like usage: a malformed value
  is dropped by the API's body schema, never a 400.
- **Cost is priced at read time, never persisted.** The Insights rollups turn
  the stored `usage` × the identity's model into money against the operator's
  `AI_PRICING` table (`estimateTokenCost` in `apps/api/src/platform/ai-pricing.ts`)
  each time they are read, so correcting a mispriced entry retroactively re-values
  history. Three states stay distinct and never render as `$0`: **priced** (a
  price entry matched), **unpriced** (usage reported, no matching entry), and
  **unmetered** (no usage — the CLI case, via the existing `jobsWithUsage`
  mechanism). Consumed by the C11 AI-usage chart, the per-flow cost view
  (`/insights/ai-cost/by-flow`), and the per-schedule Cost column
  (`/insights/ai-cost/by-schedule`).
- **flowId on the input attributes spend (attribution only).** The per-flow and
  per-schedule cost rollups read the flow off the stored job input at
  `data->'input'->>'flowId'` (the pg-boss JobEnvelope). Most flow-scoped AI jobs
  already carry it; `verify_document` and `draft_markdown_proposal` were extended
  to carry it too so the correctness patrol and gap reconciler attribute
  correctly — the field is metadata the runners ignore, absent on the unscoped
  flow. `answer_question` and the `fold_*` jobs carry no flowId, so their spend is
  *unattributed* in the per-flow view and excluded from per-schedule attribution.
- **Reading a completed job's output back (#184).** Because the persisted output
  is the `{ result, executor, usage?, provider?, model? }` envelope, any API-side consumer of
  `runJobToCompletion` must parse it through `parseCompletedJobOutput(schema,
  job.output)` (`apps/api/src/features/jobs/service.ts`) rather than running the
  raw output schema against `JobView.output` directly — the raw parse only ever
  succeeds against test fakes that complete without the envelope, and silently
  discards real watcher results. The gap reshape, the patrol verify lens, and
  gap-closure re-asks all read through this helper.
- **The watcher retries the `complete()` POST itself.** `HttpWatcherApi.complete()`
  (`apps/watcher/src/http-client.ts`) retries a failed completion POST a few times
  with backoff before giving up, but only for a network error or a `5xx` — a `4xx`
  (e.g. `invalid_output`, `job_not_found`) is a deterministic contract failure no
  amount of retrying fixes, so those still fall straight through to `api.fail()`.
  This is safe because `POST /:id/complete` is idempotent on the API side (above).
  The two mechanisms compose into **self-healing side effects**: a transient
  side-effect failure surfaces as a retryable `500 side_effects_failed`, the
  watcher re-POSTs with backoff, and the replay branch re-runs only the side
  effects. If the retries exhaust, the watcher's `api.fail()` fallback is a
  harmless no-op on the completed row (pg-boss's `state < 'completed'` guard), so
  the terminal state is still a completed job whose output survives — the
  side-effect failure stays in the logs and a later manual re-POST of `/complete`
  can still replay the bookkeeping.
- **Schema-invalid output** (`invalid_output`) is unchanged: it still fails the job
  through the normal retry budget. There is no cheap, low-risk way to force pg-boss
  to skip straight to a terminal `failed` state for this one failure category
  without reaching into pg-boss internals the public `fail()`/`cancel()` API
  doesn't expose (see the code comment in `completeJob`) — a from-scratch "repair
  reprompt" would fix this properly but is out of scope here.

## Proposal Review

Gap candidates can be turned into proposal jobs:

```json
POST /api/proposals/from-gap
{
  "summary": "No source material found for: How do I trim claws?",
  "destinationId": "cats-docs"
}
```

The API enqueues a `draft_markdown_proposal` job with the triggering questions and any available evidence citations.
Like seeding, gap drafting is **source-grounded**: the job carries `sources: SourceDescriptor[]` (references to the
flow's configured sources), not an inline file sample — the API no longer samples source files at enqueue time. The
watcher resolves git/local descriptors to read-only workspaces and the agent explores them directly (CLI tier traverses
the checkout with its own tools; HTTP tier runs the bounded `list_dir`/`read_file`/`grep` tool loop), using the same
`MAGPIE_AGENTIC_TIMEOUT_MS` agentic timeout as seeding. Both the demand-driven `draftFromGaps` path and the stale-PR
regeneration path project descriptors this way.
When the watcher completes that job, the API stores the generated Markdown proposal for review. The proposal's
file location is derived from the destination — `<destination docs subpath>/<title-slug>.md` — so it is consistent
across providers; any `targetPath` returned by the provider is not used to place the file.

Drafts are register-constrained (#213): every content-producing prompt (gap drafts, seed
drafts, both folds, source-sync rewrites, corrective rewrites, improve growth) carries a
shared factual-register contract — documents state what the sources state, and never
author their own recommendations, next steps, action items, roadmaps, or editorial
commentary (describing a plan a *source itself states* remains allowed). Points the
sources do not cover are **omitted from the document body** and reported in the draft
output's optional `uncoveredPoints` field; the API logs a warning and folds them into
the proposal's rationale so the reviewer sees what could not be supported. As a
backstop, the API runs an advisory-heading check (`findAdvisoryHeadings` in
`@magpie/markdown`) over every draft/rewrite/fold output it consumes: a draft containing
headings like "Recommendations", "Next steps", "Action items", "Roadmap" or "Future
work" is **flagged, never failed** — a structured log warning plus a "Register check:"
note on the proposal rationale — because a document may legitimately describe a roadmap
its source states. At the two fold appliers (`applyFoldFromCompletedJob`,
`applyChangesetFoldFromCompletedJob` in `apps/api/src/scheduling/fold.ts`) the check is
**log-only**: a fold rewrites markdown, not rationale, so the surviving proposal's
original draft-time rationale note (if any) survives the fold untouched. `dedupe_documents`
and `split_document` outputs are **deliberately not checked**: they reorganise existing KB
content rather than author anything new, so any advisory heading present already pre-dates
the proposal.

Drafts also carry **per-claim provenance** (#214): both draft outputs
(`draft_markdown_proposal`, `draft_seed_document`) include an optional
`provenance: ProvenanceClaim[]` field — each substantive claim in the drafted markdown
with the source id + repo-relative path(s) that ground it. The document **body contains no
repository paths or source names** (the old inline "(see …)" citations leaked into answers
served by `answer_question`); citations live only in the structured field. The API persists
it on the proposal (`proposals.provenance`, migration 0049) where it follows event-log
semantics: a **merged** proposal's row is the permanent provenance event for its target
path. Reviewers see the map in the PR body ("Claim provenance" section, rendered by the
watcher's publication runner) and in the console's proposal view. A draft that omits the
field is warned about but still published — quality is enforced by review and (phase 2)
the verify patrol, never by rejecting drafts. Legacy inline citations in already-published
documents are cleaned up organically by the verify→correct patrol, which flags them as
formatting defects.

The **rewrite jobs are provenance events for their own diffs** too (#214 phase 3):
`correct_document` and the `improved: true` branch of `improve_document` carry the same
optional `provenance` field — the claims their rewrite introduces or materially changes,
cited in the structured field instead of the prose rationale — persisted onto the
corrective/improve proposal by the completion handlers (an `improved: false` no-op grounds
no new claims and never warns). `fold_markdown_proposal` receives both parents' provenance
(`survivorProvenance`/`rivalProvenance` on its input) and returns the merged document's
re-anchored `provenance`; the fold applier rewrites the survivor's provenance event with
the folded content (`ProposalStore.setProvenance` — the only post-create provenance
write), falling back to concatenating both parents' claims (with a log warning) when the
fold output carries none. **Documented limitation:** `dedupe_documents` and
`split_document` changesets carry no per-claim provenance — their PRs describe the
content move, `git blame` through the move reaches the pre-move provenance events, and
phase 2's anchor-staleness guard makes the verify patrol fall back to full re-derivation
for restructured sections. (The changeset fold accordingly concatenates the parents'
claims onto the survivor rather than dropping them.) Revisit only if verify's fallback
rate on moved documents proves noisy in practice. Design:
[the claim-provenance spec](superpowers/specs/2026-07-08-claim-provenance-design.md).

```bash
curl -s http://localhost:4000/api/proposals
```

A proposal moves through a status lifecycle: `draft`, `ready`, `branch-pushed`, `pr-opened`,
`merged`, `rejected`. Update it directly:

```bash
POST /api/proposals/:id/status
{ "status": "ready" }
```

### Gap-closure verification (`verify_gap_closure`)

A merge no longer *blindly* resolves the gaps a proposal was drafted to close. When a
proposal is marked `merged` (the PR poller for a hosted destination, or the console's
Merge action for a local-git one), the merge cascade re-indexes the destination and, if
the proposal had triggering questions, enqueues a **`verify_gap_closure`** maintenance job
`{ proposalId }`. A maintenance watcher claims it and POSTs
`POST /api/proposals/:id/verify-closure`; the orchestration lives in the API because it
needs DB access.

For each triggering question the API **re-asks it** — recording a fresh question log and
running it through the normal queue-only `answer_question` path (flow pinned via
`requestedFlowId`) against the now-updated index — then applies a deterministic closure
test: the question is **closed** only when the re-ask returns a confident answer
(`high`/`medium`) that **cites one of the merged proposal's target docs** and **raises no
`auto` gap of its own** (a substantive partial answer ships at `medium` while still
declaring a whole-question gap, so confidence alone does not prove the question was
answered gap-free; `followup` gaps do not block closure). Outcomes, per proposal
(`proposals.closure_status`):

- **`verified_closed`** — every triggering question closed; the gaps are now resolved.
- **`reopened`** — at least one question is still open; those gaps stay open and gain a
  `verification`-source row carrying the failure detail as a `note`, so they re-draft. That
  note is fed to the next `draft_markdown_proposal` as `resubmissionNotes`, so the drafter
  sees why the previous merge fell short and addresses the specific shortfall.
- **`needs_attention`** — a question has failed verification twice (`CLOSURE_RETRY_CAP`);
  its `verification` gap is stamped `parkedAt`, a first-class "awaiting a human" state (not
  a source) that parks the whole question from auto-redrafting. A human retries or dismisses
  it from the console's Parked questions panel (see [question-logging.md](question-logging.md)).

The re-asks run **concurrently** and — critically — an incomplete re-ask is not a verdict.
A re-ask that never reaches a `completed` answer (no provider watcher was free before its
deadline) makes `verifyGapClosure` throw; the endpoint returns `503` and the
`verify_gap_closure` job retries, rather than the API recording a false `still_open` that
would wrongly reopen/park a correctly-merged doc. Because the claiming watcher blocks in
this callback while it waits on the re-asks, **verification needs a second watcher free to
answer them** — on a single-watcher deployment it never completes and the proposal reads
honestly as *unverified* (see [question-logging.md](question-logging.md)); the console
warns when only one watcher is connected.

Every re-ask is recorded in `gap_closure_verification` (verdict, confidence, whether it
cited a merged doc, detail). Clusterless / seed proposals have no triggering questions and
skip verification. The only generative step is the enqueued `answer_question` re-ask, so
queue-only holds. See [question-logging.md](question-logging.md) for the gap sources.

Once a proposal is `ready` and its target path maps to an indexed Git checkout, it can be
published:

```bash
POST /api/proposals/:id/publish
```

Publication is enqueue-only. The API validates the repository pre-flight and enqueues a
`publish_proposal` job, returning `202` with the queued job. The watcher publication runner fetches
`GET /api/proposals/:id/execution-context` (the proposal plus a credential-free repository config),
commits the Markdown to a new `magpie/proposal-*` branch and pushes it. For a GitHub destination it
then opens a pull request; for a local-git (`file://`) destination it stops at the pushed branch (no
PR to open) and the console's **Accept** (merge) / **Bin** (reject) actions complete the review. It
reports the result back via job completion — which records the branch, commit SHA, and (for GitHub)
PR URL on the proposal. Invalid publishes fail fast with the same `404`/`409` codes before any job is
created.

### Local-git flows (`file://` destinations)

A flow whose destination resolves to a `file://` git repo publishes without any GitHub ceremony. A
destination is recognized as local-git however its `file://` URL is written in `KNOWLEDGE_DESTINATIONS`
(bare string, `path`, or `url`). For such a flow:

- Publishing routes to `publish_proposal__local_git` (push a review branch, no PR).
- The console shows **Accept** (`POST /api/proposals/:id/merge` — merge the branch into the default
  branch, resolve gaps, re-index) and **Bin** (`POST /api/proposals/:id/reject` — mark `rejected`,
  freeze the gap cluster so it is not re-drafted, and delete the review branch). Bin is the local
  mirror of a GitHub pull request closed without merging.
- The github-only `refresh_flow_snapshot` PR-poll task is **not** scheduled for a local-git flow, and
  `crosslink_pull_requests` / `comment_pull_request` never fire (they only act on `pr-opened`
  proposals, which a local-git flow never reaches).

## Seeding a flow

The demand-driven pipeline above (question → gap → cluster → proposal) is how knowledge
*evolves* from real usage. To **bootstrap** a new flow — or add a whole new area of knowledge
to an existing one — seeding is **self-seeding**: planning starts from the flow's *sources*,
not from a human-typed topic, and every plan waits behind a human review gate before anything
is drafted.

### Planning (`outline_flow_seed`)

```json
POST /api/flows/:flowId/outline
{ "notes": "optional freeform steer for this run" }
```

There is **no topic**. The endpoint enqueues an `outline_flow_seed` job whose input carries
`sources: SourceDescriptor[]` (the flow's configured sources), the flow's whole existing
document inventory (path + title, unscored), and the flow's optional `persona`, `charter`
and `routingSummary` from `KNOWLEDGE_FLOWS`, plus `origin: "manual" | "auto"` recording what
triggered the run. It is one of the **source-grounded** job set: the watcher resolves the
git/local descriptors to read-only workspaces and the agent explores them directly (CLI
providers traverse natively; HTTP providers use the bounded tool loop), then proposes a
complete, non-overlapping document plan for the whole flow — fitted to the existing docs,
scoped by the `charter` when configured. When the flow lacks a charter (or persona) the
model **proposes** one (`proposedCharter` / `proposedPersona` on the output); the system
never writes flow config — the console shows the proposal with a copy-to-config hint, and
the value is carried run-scoped on the plan. Outline outputs may also contribute source-map
`mapUpdates` like the other source-grounded jobs.

On completion the API persists a **seed plan** (`seed_plans` table, status `proposed`,
idempotent on the outline job id); a fresh proposed plan supersedes an older still-proposed
one for the same flow. The endpoint reuses an in-flight outline job for the flow rather than
double-planning (`{ jobId, reused: true }`), requires the `manage:jobs` scope (and `manage`
on the target flow), and returns the enqueued job id.

### Review and approval (the human gate)

Plans are reviewed on the console's **Seed** page or via the API:

- `GET /api/flows/:flowId/seed-plans` — the flow's plans, newest first.
- `GET /api/seed-plans/:id`, `PATCH /api/seed-plans/:id` — read and edit (charter/persona
  text, per-item fields, per-item approve/dismiss). Editing is only allowed while the plan
  is `proposed` (409 otherwise).
- `POST /api/seed-plans/:id/approve` — flips the plan to `approved` and enqueues one
  `draft_seed_document` per non-dismissed item, carrying the plan's run-scoped
  `charter`/`persona` and `seedPlanId`. Replay-safe: items that already recorded a
  `draftJobId` are skipped, so re-approving after a mid-loop failure completes the
  remainder. Rejects with `coverage_required` when an approvable item has no coverage.
- `POST /api/seed-plans/:id/dismiss` — a sticky human "no" (see the bootstrap below).

**Plan approval is the only drafting entry point** — the old raw-items
`POST /api/flows/:flowId/seed` endpoint is gone.

### Drafting (`draft_seed_document`)

Each approved item drafts through a `draft_seed_document` AI job, grounded in the flow's
source repositories exactly as before (source-grounded workspaces; CLI native traversal or
the HTTP bounded tool loop; `MAGPIE_AGENTIC_TIMEOUT_MS` default 600 000 ms — keep it below
the 900 s queue expiration; a job whose filesystem sources all fail to resolve fails loudly).
The input now also carries the plan's `charter` (bounds scope), `persona` (shapes voice) and
`seedPlanId` — read back at completion to stamp the proposal's `seedPlanId` so the plan view
can show per-item drafting/publication progress.

Coverage points the sources do not support are omitted from the authored document and come
back in `uncoveredPoints`, folded into the proposal rationale (see the register constraint
above). Per-claim citations come back in `provenance` and are persisted on the proposal. On
completion the API creates a clusterless proposal carrying the flow's id first-class and
reconciles it through the shared gate: a seed doc that overlaps an open PR on the same path
folds into it, otherwise it self-publishes as its own PR. Seeding still ends at a reviewable
pull request — the same human gate as everything else.

### Sparse-flow bootstrap (`seed_bootstrap`)

A per-flow scheduled task (`seed-bootstrap`, hourly by default) makes seeding
self-starting: the maintenance watcher POSTs the thin
`POST /api/flows/:flowId/seed-bootstrap/run` endpoint, which checks guards cheapest-first
and **no-ops** (reporting the reason) unless all hold: the flow has ≥1 source; the indexed
destination has fewer than `SEED_BOOTSTRAP_MAX_DOCS` documents (default 3); no `proposed`
plan is pending; no outline job is in flight; no open seed-originated proposals exist for
the flow; and the latest `dismissed` plan's source hash differs from the flow's current
sources (dismissal is sticky per source config — a human "no" is only re-litigated when the
sources change). When every guard passes it enqueues `outline_flow_seed` with
`origin: "auto"` and returns immediately — unlike the patrol orchestrators it never
bounded-waits; the plan lands via the completion handler and waits for human review.

### MCP

Over MCP the two steps are `kb_outline` → `kb_seed`: `kb_outline` (flow + optional `notes`)
enqueues the planning run, waits for it, and returns the **persisted plan**
(`planId`, `charter`/`persona` with proposed flags, `items`, `rationale`); `kb_seed`
approves a plan by id and returns the enqueued draft job ids. Editing or partially
dismissing items happens in the console.

## Patrol child jobs (`verify_document` / `correct_document` / `improve_document`)

The hourly patrols (`correctness_patrol` / `editorial_patrol` — see
[architecture.md](architecture.md) for the scheduled-task table) fan out into three
provider jobs, one document at a time: `verify_document` decides whether a doc's claims
are still supported by the flow's sources, `correct_document` repairs the claims verify
flagged, and `improve_document` grows a healthy-but-thin doc. All three are
**source-grounded** the same way as `draft_seed_document` and `draft_markdown_proposal`:
each input carries the document (`path`, `content` — plus the flagged `claims` for
correct) and `sources: SourceDescriptor[]` — references to the flow's configured sources,
projected at enqueue time, never inline file content. The watcher resolves the git/local
descriptors to read-only workspaces on the shared checkout volume and the executing agent
explores them directly — CLI providers (`claude`, `codex`) traverse the checkout with
their own tools under read-only enforcement assembled in code; HTTP providers
(`openai-compatible`, `azure-openai`) run the bounded `list_dir`/`read_file`/`grep` tool
loop — under the same `MAGPIE_AGENTIC_TIMEOUT_MS` agentic timeout as the draft jobs
(default 600 000 ms / 10 min; the three queues expire at 900 s to leave headroom, and the
patrol tick's bounded wait on a `verify_document` job stays pinned at 10 min so one hung
verify cannot consume the whole maintenance envelope). `agent` sources render as
reference-only prompt notes. `internet` sources do too by default, **unless** the
operator opted the descriptor into fetching with a non-empty `allowedHosts`
allowlist (#242 — see [ingestion.md](ingestion.md)):

- **HTTP providers** get a `fetch_url` tool alongside the filesystem tools: https
  only, exact-hostname allowlist re-checked on every redirect hop, text-only
  content-type gate, 2 MB download cap, HTML reduced to readable text, 32 KB
  slices charged against the same 400 KB read budget as `read_file`, and every
  retrieval logged (`fetch_url: fetched internet source`). A job whose only real
  grounding is fetchable internet sources runs the tool loop with a
  fetch-only toolset instead of the one-shot path.
- **claude CLI** runs additionally get `WebFetch` in the hard `--tools` set, with
  one `WebFetch(domain:<host>)` permission rule per allowlisted host — in print
  mode anything the rules don't pre-approve is denied, so the rules are the
  enforcement. (Rule spelling follows the documented permission-rule format; not
  yet live-verified the way the read-only flags were.)
- **codex CLI** cannot fetch — its read-only OS sandbox blocks network — so for
  codex the same sources degrade to the reference-only notes they always were.
  CLI jobs with *only* internet sources also stay on the one-shot generative path.

Fetched web content is untrusted input to the drafting agent — it widens the
prompt-injection surface the same way source-repo Markdown does (see
[threat-model.md](threat-model.md)); the strict allowlist, fetch logging, and the
human merge review are the controls. A flow with no filesystem-backed **and** no
fetchable sources runs the plain one-shot path. `dedupe_documents` and
`split_document` are **not** source-grounded — they compare the document against
its destination neighbours. See the source-agentic grounding spec
([docs/superpowers/specs/2026-07-06-source-agentic-grounding-design.md](superpowers/specs/2026-07-06-source-agentic-grounding-design.md)).

`verify_document` additionally accepts an optional **`citedClaims: ProvenanceClaim[]`**
(#214 phase 2): the document's per-claim provenance, folded at enqueue time from its
merged proposals (the event log captured in phase 1 — see the provenance paragraph in the
draft-jobs section above). The patrol's default verify path reads the merged-proposal
stream for the document (`listMergedByTargetPath`, capped at the oldest 50 events with an
operator-visible warning beyond that), folds it so later merges supersede earlier ones per
claim anchor, and **drops claims whose section anchor no longer exists in the current
document content** — a stale anchor falls back to full re-derivation rather than risking a
false "cited support changed" verdict. The agent checks each cited claim against its cited
location first and flags moved/vanished support with a `cited support changed:` reason;
claims without provenance are re-derived exactly as before. The field is **advisory**: the
agent still explores the sources and trusts them over the fold, and an absent/empty fold
leaves the job input — and the rendered prompt — byte-identical to a pre-provenance
verify. The verify reuse key incorporates a hash of the folded claims, so a merge that
changes a document's provenance without touching its body never reuses a stale verdict.

## Source map (agent navigation hints)

Agents working on source-grounded jobs need lightweight navigation metadata to orient
themselves in large source codebases. The source map is a per-source store of topic-indexed
navigation hints maintained by the agents themselves: each entry pairs a topic with one or
more file paths and a one-line description, unique on `(source_id, topic)`.

**Read path.** At workspace preparation for any source-grounded job, the watcher fetches
the source map via `GET /api/source-map?sourceIds=…` (scope: `manage:jobs`) and renders
it to the agent prompt after the repository list, framed as unverified hints that the agent
may update if they are outdated or incomplete. The map is a best-effort fetch — it is
rendered only for sources that successfully respond — and the job never fails if the fetch
times out or returns partial results.

**Write path.** The six source-grounded job types — `draft_seed_document`, `draft_markdown_proposal`,
`outline_flow_seed`, `verify_document`, `correct_document`, and `improve_document` — accept an
optional `mapUpdates`
field in their output: an array of updates to the source map, keyed by `(source_id, topic)`.
Each update has the following shape:

```
{ "sourceId": string, "topic": string, "paths": string[], "description": string, "observedSha"?: string }
```

- `sourceId` — id of the source the hint belongs to.
- `topic` — short label for what the path(s) cover (max 120 chars).
- `paths` — one or more file/directory paths relevant to the topic (max 8, each ≤260 chars).
- `description` — one-line summary (max 240 chars).
- `observedSha` — stamped by the watcher, never trusted from the model; absent for non-git sources.

The completion dispatcher applies these updates best-effort: each update is merged into the store
(upsert by source+topic) and persisted to Postgres. Updates are capped at 20 per job; beyond
that limit they are dropped with a log warning. A per-source cap of 200 entries is enforced
with oldest-updated eviction: when the cap is reached, the least-recently-updated entry for
that source is evicted to make room for the new one. Malformed updates (invalid source_id,
oversized topic/paths/description) are dropped with a structured log warning and never cause
the job to fail.

**`observed_sha`.** Each source map entry records the Git HEAD SHA of the source at the time
the entry was written, stamped by the watcher during workspace preparation. This value is
always taken from the checkout HEAD, never trusted from the agent — any `observed_sha` values
supplied by the model are overwritten. Entries from non-git sources keep `observed_sha` null.

**`consensusCount`.** Each entry carries a consensus count (credibility, distinct from the
`observed_sha` currency signal). On upsert, the new hint's paths are compared to the existing
entry's via Jaccard similarity: an overlap above 0.5 means an agent independently agreed, so
the count increments (capped at 5); an overlap at or below 0.5 is a contradicting hint and
resets the count to 1, as does a first-seen `(source_id, topic)`. The count is computed
atomically (the write takes a row lock) so concurrent job completions can't lose an increment.
Higher counts mean more agents agree; surfacing/filtering hints by it is a follow-up (#219).

**Boundaries.** The source map is strictly internal metadata and **never** enters answer
retrieval, user-facing output, or the indexed knowledge base. Staleness invalidation via
source-change-sync (e.g. detecting that the HEAD SHA no longer matches and pruning stale
entries) is a follow-up tracked in #215 and not implemented in this phase.

## Watcher Model

The watcher has no direct database access. It talks to the API only:

1. Claim a job.
2. Run a provider-specific adapter.
3. Complete or fail the job.
4. Poll again.

This keeps Codex, Claude Code, and hosted APIs behind the same contract.

### Capabilities

A watcher advertises a **capability** for each provider whose credentials are
present in its environment (see `apps/watcher/src/capabilities.ts`), plus
`maintenance` (always available). The API only routes a job to a capability a
running watcher actually offers, so a job stays queued until a capable watcher is
running. Capability → required env:

| Capability | Required env |
| --- | --- |
| `openai-compatible` | `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL` |
| `azure-openai` | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_CHAT_DEPLOYMENT` |
| `codex` | `CODEX_CLI_PATH` (defaults to `codex` on `PATH`) |
| `claude` | `CLAUDE_CLI_PATH` (defaults to `claude` on `PATH`) |
| `local-git` | `MAGPIE_GIT_AUTHOR_NAME`, `MAGPIE_GIT_AUTHOR_EMAIL` (git on `PATH`; **no** token) |
| `github` | `GITHUB_TOKEN`, `MAGPIE_GIT_AUTHOR_NAME`, `MAGPIE_GIT_AUTHOR_EMAIL` |
| `maintenance` | (none) |

`publish_proposal` fans out over `{github, local-git}` by destination: a `file://`
destination routes to `publish_proposal__local_git` (branch push only — a token-less
watcher can serve it, and the console's Merge action takes over from there), anything
else to `publish_proposal__github` (push **and** open a PR). A `github`-credentialed
watcher also satisfies `local-git` (it has git + author), so it publishes to both.

## AI Providers

`AI_PROVIDER` is mandatory and names the chat provider work is routed to
(`openai-compatible`, `azure-openai`, `codex`, or `claude`). The watcher must
carry the credentials matching that provider. The watcher can also run a local
CLI (Codex / Claude Code) as the provider. CLI providers cover the non-embedding
LLM job contract; embeddings remain configured separately through OpenAI-compatible
or Azure embedding endpoints.

OpenAI-compatible API watcher:

```bash
AI_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1 \
OPENAI_COMPATIBLE_API_KEY=... \
OPENAI_COMPATIBLE_MODEL=... \
npm run dev:watcher
```

Codex-style command:

```bash
AI_PROVIDER=codex \
CODEX_CLI_PATH=codex \
CODEX_CLI_ARGS=exec \
CODEX_CLI_PROMPT_MODE=arg \
npm run dev:watcher
```

Claude-style command:

```bash
AI_PROVIDER=claude \
CLAUDE_CLI_PATH=claude \
CLAUDE_CLI_ARGS=-p \
CLAUDE_CLI_PROMPT_MODE=arg \
npm run dev:watcher
```

Prompt mode can be:

- `arg`: append the prompt as the final process argument.
- `stdin`: send the prompt through standard input.

The agent must return JSON matching the job output schema. The watcher extracts and validates JSON before completing the job.

### CLI environment isolation

A local agent CLI boots as a full interactive assistant by default — its own system
prompt and persona, the complete toolset, and whatever MCP servers, settings, hooks, and
project memory (CLAUDE.md) the operator's environment or the working directory carries.
Left unisolated, a one-shot completion run can behave like a chat session (one incident:
a `claude -p` answer job replied by asking the reader to grant it MCP tool permissions,
and that chatter shipped as the answer). The runner therefore assembles isolation args in
code (`apps/watcher/src/runners/cli.ts`), after the operator-configured
`CODEX_CLI_ARGS` / `CLAUDE_CLI_ARGS`, so configuration cannot drop them:

- **One-shot generative runs** execute in a neutral working directory (the OS temp dir —
  no host-project CLAUDE.md / `.mcp.json` / `.claude` settings) with, for claude,
  `--tools ""` (no tools), `--strict-mcp-config` (no MCP servers),
  `--setting-sources ""` (no user/project settings, hooks, or plugins), and
  `--system-prompt` carrying the job-runner instructions so they replace the CLI's
  interactive persona instead of riding as user text. codex gets `--sandbox read-only
  --skip-git-repo-check` (it has no system-prompt flag, so its prompt keeps the folded
  `SYSTEM:` block).
- **Source-grounded runs** keep the read-only explore toolset (`--tools Read,Grep,Glob`
  plus disallowed write tools for claude; `--sandbox read-only` for codex) and, for
  claude, also get `--strict-mcp-config` and `--setting-sources ""` — a source checkout
  may carry its own `.mcp.json` (this repo does) or committed `.claude` settings, and
  neither may reach the agent.

Defence in depth on the answer side: an `answer_question` reply that ignores the
structured JSON contract (plain prose) is always grounding-verified despite its low
confidence, and fails closed — if the verifier cannot vouch for the prose, the safe
fallback answer ships instead of the raw text.

## Provider Compatibility Practice

Provider support should stay behind `AgentRunner` adapters:

- Normalize every provider to the same internal job contract.
- Keep prompts and output schemas provider-neutral.
- Validate provider output before completing jobs.
- Prefer OpenAI-compatible `/chat/completions` support for broad API coverage.
- Keep provider credentials in environment variables, never in job payloads.
- Use timeouts around external calls and mark jobs failed with readable errors.
- Add one conformance smoke test per provider shape: answer job, gap summary job, and proposal job.

## Storage

Use `STORAGE_BACKEND=postgres` for local development and deployments. Optional backend
overrides: `SOURCE_MAP_STORE` selects the storage backend for the source map (useful for
testing or alternate implementations; defaults to postgres when not set).

Jobs and schedules are owned entirely by pg-boss (the `JobBroker`), which manages its own
Postgres tables. The legacy custom job table and its queue-selection override have been
removed. pg-boss handles claiming, retries, and overlap protection so multiple watchers can
safely poll the same queues once the API is running against a real database.
