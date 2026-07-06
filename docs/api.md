# HTTP API Reference

The API is a plain Node HTTP server. It listens on `PORT` (default `4000`), and all API
endpoints are served under `/api`. In local development the API base URL is
`http://localhost:4000/api`.

## Conventions

- All requests and responses are JSON (`content-type: application/json`).
- CORS defaults to open (`access-control-allow-origin: *`), and `OPTIONS` preflight
  requests return `204`. Set `CORS_ALLOWED_ORIGINS` to a comma-separated allow-list
  (e.g. the web origin) to restrict which origins may call the API in production.
- Every response carries standard security headers (`X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, and `Strict-Transport-Security`).
  HSTS is only honoured by browsers over HTTPS; TLS termination is assumed to happen
  upstream (the same headers are also emitted by the MCP HTTP server and the web app).
- Errors return a JSON body with an `error` code, e.g. `{ "error": "question_required" }`.
  Some errors add a human-readable `message`. An uncaught failure returns `500` with
  `{ "error": "internal_error", "message": "..." }`.
- List endpoints accept a `limit` query parameter. It is clamped to between `1` and `200`.

## Health & Config

### `GET /api/health`

Liveness check. Public — served before the auth middleware.

```json
{ "ok": true, "service": "markdown-magpie-api" }
```

### `GET /api/ready`

Deep readiness check, in contrast to `/health`'s shallow liveness. Verifies the running
process can actually serve traffic: Postgres is reachable (`SELECT 1` via the shared
connection pool) and the pg-boss job broker has started. Public — served before the auth
middleware, so orchestrator probes need no token. Returns `200` when ready and `503`
otherwise, with a body reporting each dependency:

```json
{ "ready": true, "checks": { "database": true, "broker": true } }
```

Use `/ready` for readiness/startup probes (gate traffic on dependencies) and `/health`
for liveness probes (restart on a hung process). An all-in-memory build (e.g. tests) has
no Postgres dependency, so `database` is reported `true`.

### `GET /api/version`

Identity of the running build, so clients can tell which commit is live. Public, like
`/health`. The values are baked into the container image at build time (see the
Dockerfile `ARG`s and `.github/workflows/publish-image.yml`): `sha` is the deployed
commit's short SHA, `commitMessage` its subject line, and `committedAt` the commit's
committer date (i.e. the merge time) as an ISO-8601 string. All three are `null` when
the image was built without those args (local development), in which case the console
shows a "Development" build.

```json
{
  "sha": "a97380b",
  "commitMessage": "fix: write folded content into a changeset survivor's primary entry",
  "committedAt": "2026-06-29T22:14:03+01:00"
}
```

### `GET /api/config`

Returns the resolved runtime configuration: API settings, storage backends (with the
database URL masked), configured knowledge repositories, provider settings and secret
presence (`set` / `not set`), the AI runtime (current provider plus the available
providers), watcher settings, and retrieval settings including `retrieval.mode`
(`hybrid` or `keyword`) and a plain-language `reason`.

### `POST /api/config`

Switches the active AI provider at runtime. Accepts either a flat or nested shape:

```json
{ "aiProvider": "openai-compatible" }
```

```json
{ "ai": { "provider": "openai-compatible" } }
```

- `200` — returns the updated config (same shape as `GET /api/config`).
- `400 valid_ai_provider_required` — provider missing or unrecognised.
- `400 unsupported_ai_provider` — the provider is not configured by environment variables.

See [chat-providers.md](chat-providers.md) for provider configuration.

### `POST /api/admin/reset`

Resets the application to its fresh-from-`.env` state. Intended for demos.

**Warning:** This endpoint is unauthenticated and destructive. It is a demo aid and must not be exposed in a production deployment.

Clears all questions (and their citations), proposals, gap clusters, jobs, and the indexed knowledge (sections, documents, repositories); resets the runtime AI provider to the `.env` default; then re-syncs the configured git checkouts and re-indexes the configured knowledge sources.

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

`failures` lists any configured source that could not be re-indexed (`{ "target": "<flow or repository id>", "message": "<reason>" }`); the clear still completes fully even if re-indexing a source fails.

## Knowledge

### `POST /api/ask`

Answers a question from indexed Markdown context.

```json
{ "question": "How do I rollback a hotfix?" }
```

- `400 question_required` — empty or missing question.
- `202` — `{ "questionId": "...", "job": Job, "links": { "question": "/api/questions/:id",
  "job": "/api/jobs/:id", "wait": "/api/jobs/:id/wait", "cancel": "/api/jobs/:id/cancel" } }`.
  An `answer_question` job is enqueued for a watcher and the question log is written immediately
  with unknown confidence. Block on `links.wait` until the job is terminal, then read the answer
  from `links.question`. The watcher answers via an agentic retrieval loop: it routes the question
  to a flow, retrieves scoped context (weak matches below a relevance floor are dropped, so a
  question nothing answers yields no citations), and may run bounded follow-up searches within that
  flow before answering — citing only the sections it used. See [ai-jobs.md](ai-jobs.md) and
  [question-logging.md](question-logging.md).

### `GET /api/knowledge/search?q=<query>&limit=<n>`

Searches indexed sections. `limit` defaults to `5`. When hybrid retrieval is active (Postgres + embeddings configured), results are ranked by Reciprocal Rank Fusion of pgvector nearest-neighbour and keyword scores; otherwise keyword scoring is used. Each result carries a `[0,1]` relevance score.

- `400 query_required` — missing `q`.
- `200` — `{ "sections": [ DocumentSection, ... ] }`.

### `POST /api/knowledge/repositories/index`

Indexes the destination KB for a configured flow. See [ingestion.md](ingestion.md).

```json
{ "flowId": "docs" }
```

`flowId` must match an entry in `KNOWLEDGE_FLOWS`. The API indexes that flow's destination
repository/folder, which is the curated KB used by `/ask` and MCP. `repositoryId` remains accepted
as a direct destination ID for compatibility. Arbitrary `localPath` values are rejected while
configured destinations exist.

For older single-repository deployments, `KNOWLEDGE_REPOSITORIES` and `KNOWLEDGE_REPO_PATH` are
still used as fallbacks when `KNOWLEDGE_SOURCES` / `KNOWLEDGE_DESTINATIONS` are unset.

- `400 configured_repository_required` — multiple repositories are configured and no valid ID was supplied.
- `400 local_path_not_allowed` — a client attempted to submit an arbitrary server path.
- `400 local_path_required` — no repository is configured and no legacy path was supplied.
- `200` — an indexed-repository summary: `{ repository, documentCount, sectionCount, commitSha }`.

### `GET /api/knowledge/repositories`

Lists indexed repositories.

```json
{ "repositories": [ RepositoryRef, ... ] }
```

### `GET /api/knowledge/documents`

Lists indexed documents, sorted by path.

```json
{ "documents": [ KnowledgeDocument, ... ] }
```

### `GET /api/knowledge/stats`

Index counts.

```json
{ "repositoryCount": 1, "documentCount": 12, "sectionCount": 84 }
```

## Questions & Gaps

See [question-logging.md](question-logging.md) for the recorded fields and lifecycle.

### `GET /api/questions?limit=<n>`

Lists question logs (newest first). `limit` defaults to `50`.

```json
{ "questions": [ QuestionLog, ... ] }
```

### `GET /api/questions/parked?limit=<n>`

Lists questions **parked awaiting a human** — their gap-closure verification failed
past the retry cap, so they are frozen from auto-redrafting (see
[question-logging.md](./question-logging.md)). `limit` defaults to `50`. Registered
before `/:id`, so `parked` is never read as a question id.

```json
{
  "questions": [
    { "questionId": "...", "question": "...", "flowId": "...", "summary": "...", "note": "why the merge still fell short", "parkedAt": "..." }
  ],
  "proposals": [
    { "proposalId": "...", "title": "...", "reason": "triggering_question_deleted" }
  ]
}
```

`questions` are the parked questions an operator can act on (retry / dismiss below).
`proposals` are the edge case where a merged proposal parked (`closure_status =
needs_attention`) but its triggering question log was deleted, so there is no parked
question to act on — surfaced read-only so the escalation is not invisible.

### `GET /api/questions/:id`

- `404 question_not_found`.
- `200` — `{ "question": QuestionLog }`.

### `POST /api/questions/:id/feedback`

Records helpful/unhelpful feedback on an answer.

```json
{ "feedback": "helpful" }
```

- `400 valid_feedback_required` — value is not `helpful` or `unhelpful`.
- `404 question_not_found`.
- `200` — `{ "question": QuestionLog }`.

Feedback is the answer-quality axis. Whether the answer exposed a knowledge gap is tracked separately (see below) and the two can both be set on the same question.

### `POST /api/questions/:id/gap`

Manually flags a question as a knowledge gap the automatic detection missed. The optional `summary` becomes the gap summary used for clustering; when omitted it falls back to the question's existing gap summary, then to the question text.

```json
{ "summary": "Adoption process is undocumented" }
```

- `404 question_not_found`.
- `200` — `{ "question": QuestionLog }`.

### `DELETE /api/questions/:id/gap`

Clears the manual knowledge-gap flag. Any automatically-detected `gap_summary` is left intact, so un-flagging never removes a gap the system found on its own.

- `404 question_not_found`.
- `200` — `{ "question": QuestionLog }`.

### `POST /api/questions/:id/gap/retry`

Human **retry** on a parked question: re-admits it to the draft pipeline with a fresh
retry budget (ends the failed verification lineage; re-files the gap with its note when
the underlying gap is gone). No-op (still `200`) if the question exists but is not parked.

- `404 question_not_found`.
- `200` — `{ "question": QuestionLog }`.

### `POST /api/questions/:id/gap/dismiss`

Human **dismiss** on a parked question: abandons the topic by dismissing every live gap
for the question. No-op (still `200`) if the question exists but is not parked.

- `404 question_not_found`.
- `200` — `{ "question": QuestionLog }`.

### `GET /api/gaps/candidates?limit=<n>`

Lists knowledge-gap candidates grouped by gap summary. A question is included when it is a low-confidence automatic gap **or** has been manually flagged (regardless of answer confidence). `limit` defaults to `50`.

```json
{ "gaps": [ GapCandidate, ... ] }
```

### `GET /api/gaps/clusters?limit=<n>`

Returns the **persisted** gap clusters the reconciler maintains — sets of related gaps that a single
proposal could resolve (e.g. "do cats like cheese?", "is cheese bad for cats?" and "what if a cat
eats lots of cheese?" form one cluster). This is a fast read straight from the store with **no model
call**: clustering happens in the background reconciler, not on this request. Only `active` clusters
are returned. `limit` defaults to `50`.

```json
{ "clusters": [ PersistedGapCluster, ... ] }
```

Each `PersistedGapCluster` has `{ id, title, summaries, questionIds, count, rationale?, flowId?,
status, proposalId?, proposalStatus?, lastReconciledAt }`:

- `status` — always `"active"` for clusters returned here (frozen clusters are historical and omitted).
- `proposalId` / `proposalStatus` — the proposal linked to the cluster, if one has been drafted.
- `lastReconciledAt` — when the reconciler last touched the cluster.

### `POST /api/gaps/clusters/:id/proposal`

Manually drafts one proposal for a persisted cluster, links the proposal to the cluster, and queues
it for publication. The cluster's own flow routes the draft, so the body is optional:

```json
{ "targetPath": "optional/path.md", "destinationId": "optional-destination" }
```

Both fields are optional and override the flow's defaults when supplied. Drafting is
enqueue-only: the response is `{ "ok": true, "job": Job }`, and the proposal is created when
the watcher completes the `draft_markdown_proposal` job.

- `404 cluster_not_found` — no active cluster with that id.

## Proposals

See the Proposal Review and Storage sections in [ai-jobs.md](ai-jobs.md).

### `GET /api/proposals?limit=<n>&status=<status>`

Lists proposals, newest first. `limit` defaults to `50`.

By default the list is the active inbox: it omits the **settled** statuses
(`merged`, `rejected`, `superseded`) so nothing terminal lingers there with no
available action. Pass `status=<status>` to fetch exactly one status instead —
including the settled ones — so history stays reachable (e.g. `status=superseded`
to audit what was folded away). An unrecognised `status` is ignored and the
default inbox is returned.

```json
{ "proposals": [ Proposal, ... ] }
```

### `POST /api/proposals/from-gap` &nbsp;·&nbsp; `POST /api/proposals/from-gaps`

Drafts **one** `draft_markdown_proposal` from one or more known gap candidates. Use `from-gaps`
with a `summaries` array to draft a single proposal that covers a confirmed cluster of related
gaps; `from-gap` with a single `summary` remains for the one-gap case. Both routes accept either
field — `summary` and `summaries` are merged and de-duplicated — so a cluster of three cheese gaps
produces a single proposal instead of three near-identical ones. Evidence and triggering questions
are unioned across every gap in the request.

```json
{
  "summaries": [
    "whether cats like cheese",
    "health impact of cheese on cats",
    "consequences of cats eating large amounts of cheese"
  ],
  "sourceIds": ["agent", "flowerbi"],
  "destinationId": "flowerbi-docs"
}
```

`sourceIds` and `destinationId` are optional. At least one summary must match an existing gap
candidate. When omitted, proposal jobs use the configured sources by default and the only
configured destination when one exists.

The proposal's location is owned by the system, not the caller: the file lands at
`<destination docs subpath>/<title-slug>.md` (repository root when the destination has no
configured subpath). This keeps every proposal's folder structure consistent on its branch.
A `targetPath` field in the request body is accepted for backward compatibility but no longer
determines where the file is written.

Drafting is **enqueue-only**: the route records the request and enqueues a
`draft_markdown_proposal` job; the watcher runs the generative work and the proposal is created
later by the job-completion path. The route never drafts inline.

- `400 gap_summary_required` — empty or missing summary.
- `404 gap_candidate_not_found` — no candidate matches the summary.
- `202` — `{ "job": Job, "links": { "job": "/api/jobs/:id", "wait": "/api/jobs/:id/wait", "cancel": "/api/jobs/:id/cancel", "proposals": "/api/proposals" } }`.

### `GET /api/proposals/:id`

- `404 proposal_not_found`.
- `200` — `{ "proposal": Proposal }`.

### `POST /api/proposals/:id/status`

Sets the proposal status directly. Valid values: `draft`, `ready`, `branch-pushed`,
`pr-opened`, `merged`, `rejected`, `superseded`.

```json
{ "status": "ready" }
```

The `pr-opened → merged` transition is **owned by the PR poller** (the
`refresh_flow_snapshot` job feeds `applyPullRequestTransition`), which marks a proposal
merged only once its real pull request has merged in git — running the merge cascade
(re-index, then enqueue gap-closure verification — see `verify-closure` below) and
freezing its cluster. Hand-asserting `merged` on a proposal that has an open pull request
is therefore rejected. Manually setting `merged` remains available only as the no-PR
fallback: a proposal `branch-pushed` without a pull request to poll (e.g. a deployment
with no `GITHUB_TOKEN`, or a local-git destination), which nothing auto-transitions.

- `400 valid_proposal_status_required`.
- `404 proposal_not_found`.
- `409 proposal_merge_tracked_by_pull_request` — the proposal has an open pull request; it
  will be marked merged automatically when that PR merges.
- `200` — `{ "proposal": Proposal }` (plus `"cascadeScheduled": true` when the new status is
  `merged`).

### `POST /api/proposals/:id/merge`

**Demo/local only.** Merges a `branch-pushed` proposal whose destination is a local-git
(`file://`) repository: runs `git merge` of the pushed `magpie/proposal-*` branch into the
destination's default branch (directly in that repository's working tree), marks the proposal
`merged`, and schedules the re-index cascade in the background. Hosted (GitHub) destinations do
not use this route — their PR merge is detected by the `refresh_flow_snapshot` poller.

- Request body: none.
- `404 proposal_not_found`.
- `409 proposal_not_mergeable` — not `branch-pushed`, or no published branch recorded.
- `409 not_local_git_destination` — the destination is not a `file://` repository.
- `409 merge_conflict` — the merge could not be applied; the proposal stays `branch-pushed` and
  the git message is returned.
- `200` — `{ "proposal": Proposal, "cascadeScheduled": true }`.

### `POST /api/proposals/:id/verify-closure`

**Watcher callback** (scope `manage:jobs`). The maintenance runner POSTs here when it claims
a `verify_gap_closure` job (enqueued by the merge cascade for any merged proposal that had
triggering questions). The API re-asks each triggering question through the queued
`answer_question` path against the freshly re-indexed knowledge base and applies the
deterministic closure test — a confident (`high`/`medium`) answer that cites one of the
proposal's target docs. Gaps are resolved only when **every** triggering question closes;
otherwise they are reopened (with the verification detail as a `note`), or flagged
`needs_attention` after repeated failures. The outcome is persisted to
`proposals.closure_status` and each re-ask to `gap_closure_verification`. See
[ai-jobs.md](ai-jobs.md) and [question-logging.md](question-logging.md).

- Request body: none.
- `404 proposal_not_found`.
- `200` — `{ "proposalId": string, "closureStatus": "verified_closed" | "reopened" | "needs_attention", "perQuestion": [ { "questionId": string, "reaskedQuestionId": string | null, "verdict": "closed" | "still_open" } ] }`.

### `POST /api/proposals/:id/publish`

Publication is **enqueue-only**: the route validates the repository pre-flight (the same checks the
old synchronous publisher ran) and then enqueues a `publish_proposal` job. The git work — committing
the Markdown to a new `magpie/proposal-*` branch, pushing it, and opening a pull request — happens in
the watcher publication runner, which fetches `GET /api/proposals/:id/execution-context` and records
the result back via job completion. Invalid publishes still fail fast with the same status codes
before any job is created.

- `404 proposal_not_found`.
- `409 proposal_not_ready` — only `ready` proposals can be published.
- `409 proposal_repository_not_found` — no indexed repository matches the target path.
- `409 proposal_repository_not_git` — the matched repository is not a Git checkout.
- `202` — `{ "job": Job, "links": { "job": "/api/jobs/:id", "wait": "/api/jobs/:id/wait", "cancel": "/api/jobs/:id/cancel", "proposal": "/api/proposals/:id" } }`.

### `GET /api/proposals/:id/execution-context`

The non-generative, credential-free context the watcher publication runner fetches before executing
git. Returns the proposal record plus the resolved repository config it needs to push a branch and
open a PR (`id`, `localPath`, `remoteUrl`, `defaultBranch`, `git`). Never returns credentials. Runs
the same repository resolution + validation as the publish path.

- `404 proposal_not_found`.
- `409 proposal_repository_not_found` — no indexed repository matches the target path.
- `409 proposal_repository_not_git` — the matched repository is not a Git checkout.
- `200` — `{ "proposal": Proposal, "repository": { "id", "localPath", "remoteUrl"?, "defaultBranch", "git"? } }`.

## Jobs

Generative (chat) AI work runs through the pg-boss queue; embeddings are computed inline by
the API. The full job contract — payload shapes, job states, the client flow, the watcher
model, and provider configuration — lives in [ai-jobs.md](ai-jobs.md). Job types include
`answer_question`, `summarize_gap`, `draft_markdown_proposal`, `publish_proposal`, and the
maintenance jobs. Job states: `created`, `retry`, `active`, `completed`, `cancelled`,
`failed`, `blocked`.

### `POST /api/jobs`

Creates a job.

```json
{ "type": "draft_markdown_proposal", "input": { ... } }
```

- `400 invalid_job` — unknown/missing type or invalid input.
- `202` — `{ "job": Job }`.

### `GET /api/jobs`

Lists jobs. Optional query: `type`, `state`, `createdAfter`, `limit` (default 100, max 200),
`offset`.

```json
{ "jobs": [ Job, ... ] }
```

### `GET /api/jobs/:id`

- `404 job_not_found`.
- `200` — `{ "job": Job }`.

### `GET /api/jobs/:id/wait`

Long-polls until the job is terminal. `200` with `{ "job": Job }` once terminal; `202` with
the current `{ "job": Job }` while still running — re-issue to keep waiting (`JOB_WAIT_TIMEOUT_MS`
bounds each call, `JOB_WAIT_POLL_MS` the server poll cadence).

- `404 job_not_found`.

### `GET /api/jobs/schedules`

Lists registered pg-boss cron schedules: `{ "schedules": [ ... ] }`.

### `POST /api/jobs/:id/cancel`

Cancels a job (terminal). `404 job_not_found`; `200` — `{ "job": Job }`.

### `POST /api/jobs/:id/retry`

Retries a `failed` job. `409 job_not_failed` if it is not failed; `404 job_not_found`;
`200` — `{ "job": Job }`.

### Watcher-only endpoints

`POST /api/jobs/claim`, `POST /api/jobs/:id/heartbeat`, `POST /api/jobs/:id/complete`, and
`POST /api/jobs/:id/fail` are driven by the watcher. Claim takes
`{ "workerName", "capabilities": [...] }` and returns `{ "job": Job }` or `{ "job": null }`;
fail takes a structured `error` object. See [ai-jobs.md](ai-jobs.md).

## Insights

Read-only aggregation endpoints powering the web console's Insights page. All require the
`read:knowledge` scope and return a named-key JSON envelope of already-bucketed, **zero-filled**
series (every bucket in the window is present even when its counts are `0`, so clients render a
continuous line without gap-filling). Time params are shared: `?from=<ISO>&to=<ISO>&bucket=day|week|month`,
defaulting to the last 30 days with `bucket=day`; `flow` narrows to a single flow where supported.
Response shapes live in `packages/core/src/index.ts`.

### `GET /api/insights/gaps/backlog?from&to&bucket&flow`

Open-gap backlog trend. Buckets `question_gaps` by `date_trunc(bucket, ...)`, counting each lifecycle
transition (`opened`/`resolved`/`dismissed`/`parked`) per bucket plus the running net-open total.
`flow` narrows to a single flow.

```json
{ "series": [ GapBacklogBucket, ... ] }
```

`GapBacklogBucket` = `{ bucketStart, opened, resolved, dismissed, parked, openTotal }`. `openTotal`
is the cumulative net (opened − closed) **within the requested window** — it does not carry a
baseline of gaps opened before `from`.

### `GET /api/insights/funnel?from&to&flow`

Gap-to-merge funnel: one count per pipeline stage over the window, in pipeline order —
`questions` → `gaps` → `clustered` → `proposals` → `prs` → `merged` → `verified`. Each stage
counts the distinct entities that entered it within the window (windowed on the timestamp that
marks entry): questions on `questions.asked_at`, gaps on `question_gaps.created_at`, clustered
on gaps with an active `gap_cluster_memberships` row, proposals on `proposals.created_at`, prs
on proposals whose `status` reached `pr-opened`/`merged`, merged on `proposals.merged_at`, and
verified on `gap_closure_verification` rows with `verdict = 'closed'`. The narrowing counts make
the drop-off between stages the conversion signal.

- `400 invalid_insights_query` — malformed query.
- `200` — `{ "stages": FunnelStage[] }`.

### `GET /api/insights/jobs/throughput?from&to&bucket&type`

Job throughput & health. Buckets pg-boss jobs by their `created_on` timestamp and splits them into
`completed` / `failed` / `active` / `retry` counts per bucket. pg-boss keeps live rows in
`"<schema>".job` and migrates completed/failed rows to `"<schema>".archive` after retention, so the
rollup `UNION ALL`s both tables — otherwise finished jobs would vanish from history. `active` folds
pg-boss's `created` (queued) and `active` (executing) states together. `type`, when given, narrows to
a single job type (resolved server-side to that type's pg-boss queue names); an unknown type matches
nothing.

```json
{ "series": [ JobThroughputBucket, ... ] }
```

`JobThroughputBucket` = `{ bucketStart, completed, failed, active, retry }`.

### `GET /api/insights/answers/latency?from&to`

Answer-latency histogram (C4). Bins completed answers by how long they took end to end
into fixed latency ranges. Returns `{ "bins": LatencyBin[] }` (7 fixed bins, `0–5s`
through `5m+`, always present and zero-filled). Binned by latency range, not time, so it
takes only the window bounds. Source: pg-boss's own `job` + `archive` tables — completed
`answer_question` job rows (`state = 'completed'`), latency = `completed_on - created_on`,
windowed on `created_on`.

### `GET /api/insights/verification/success?from&to&bucket`

Verification success rate (C5). Returns
`{ "totals": VerificationSummary, "series": VerificationBucket[] }`, splitting gap-closure
verification outcomes into `closed` vs `stillOpen` overall and per bucket. Source: the
`gap_closure_verification` table (`verdict` ∈ `closed` / `still_open`, `created_at`).

### `GET /api/insights/jobs/errors?from&to`

Job error breakdown (C6). Returns
`{ "byCategory": JobErrorBreakdown[], "byType": JobErrorBreakdown[] }`, counting failed jobs
over the window split by error category and by job type (both ordered most-frequent-first).
Window-only (no time axis). Source: pg-boss's `job` + `archive` tables — failed rows
(`state = 'failed'`), windowed on `created_on` (enqueue time, matching C2's creation-time
axis — not failure time). The `JobError` payload pg-boss stores in the
job's `output` JSONB column supplies the category (`output->>'category'`, falling back to
`unknown`); the queue `name` supplies the job type after its `__<capability>` fan-out suffix
is stripped (`split_part(name, '__', 1)`).

### `GET /api/insights/freshness`

Knowledge-base freshness (C7). A point-in-time snapshot, so it takes no query params. Returns
`{ "documents": DocumentFreshness, "sources": SourceFreshness }`. `documents` classifies each
active document that carries a review cadence (`review_cycle_days IS NOT NULL`) by its next
review date (`last_verified + review_cycle_days`): `overdue` (past due, or never verified),
`due` (within 7 days), `fresh` (further out). `sources` splits every `source_sync_state` row
by `last_checked_at`: `stale` if not synced for 7 days, else `fresh`. Source: `documents`
(`status`, `last_verified`, `review_cycle_days`) and `source_sync_state` (`last_checked_at`).

### `GET /api/insights/patrols?from&to`

Maintenance patrol impact (C8). Returns `{ "runs": PatrolImpact[] }`, one row per
`maintenance_runs.task_type` over the window (windowed on `started_at`). `runs` counts
executions; `findings` sums the verify-lens findings patrol runs record (`details.findings`
JSONB array length); `proposals` sums the proposals the gap→PR reconciler drafts
(`details.proposalsDrafted`). A task type only contributes to the metric its runs actually
record; the other stays zero. Source: `maintenance_runs` (`task_type`, `details` JSONB,
`started_at`).

## Type Reference

The response shapes referenced above (`AnswerResult`, `Citation`, `DocumentSection`,
`KnowledgeDocument`, `RepositoryRef`, `QuestionLog`, `GapCandidate`, `Proposal`,
`ProposalPublication`, `GapBacklogBucket`, `LatencyBin`, `VerificationSummary`,
`VerificationBucket`, `JobErrorBreakdown`, `DocumentFreshness`, `SourceFreshness`,
`FreshnessSummary`, `PatrolImpact`) are defined in `packages/core/src/index.ts`. The `Job`
shape (`JobView`) is defined in `packages/jobs/src/types.ts`.
