# HTTP API Reference

The API is a plain Node HTTP server. It listens on `PORT` (default `4000`), and all API
endpoints are served under `/api`. In local development the API base URL is
`http://localhost:4000/api`.

## Conventions

- All requests and responses are JSON (`content-type: application/json`).
- CORS is open: every response sends `access-control-allow-origin: *`, and `OPTIONS`
  preflight requests return `204`.
- Errors return a JSON body with an `error` code, e.g. `{ "error": "question_required" }`.
  Some errors add a human-readable `message`. An uncaught failure returns `500` with
  `{ "error": "internal_error", "message": "..." }`.
- List endpoints accept a `limit` query parameter. It is clamped to between `1` and `200`.

## Health & Config

### `GET /api/health`

Liveness check.

```json
{ "ok": true, "service": "markdown-magpie-api" }
```

### `GET /api/config`

Returns the resolved runtime configuration: API settings, storage backends (with the
database URL masked), configured knowledge repositories, provider settings and secret
presence (`set` / `not set`), the AI runtime (current execution mode and provider, plus the
available `direct` and `queue` providers), watcher settings, and retrieval settings including
`retrieval.mode` (`hybrid` or `keyword`) and a plain-language `reason`.

### `POST /api/config`

Switches the AI execution mode and provider at runtime. Accepts either a flat or nested shape:

```json
{ "aiExecutionMode": "direct", "aiProvider": "mock" }
```

```json
{ "ai": { "executionMode": "queue", "provider": "openai-compatible" } }
```

- `200` — returns the updated config (same shape as `GET /api/config`).
- `400 valid_ai_runtime_config_required` — mode or provider missing/unrecognised.
- `400 unsupported_ai_runtime_config` — the provider is not configured by environment
  variables, or cannot run in the requested mode (e.g. a queue-only provider in `direct`).

See [chat-providers.md](chat-providers.md) for provider configuration.

### `POST /api/admin/reset`

Resets the application to its fresh-from-`.env` state. Intended for demos.

**Warning:** This endpoint is unauthenticated and destructive. It is a demo aid and must not be exposed in a production deployment.

Clears all questions (and their citations), proposals, gap clusters, AI jobs, and the indexed knowledge (sections, documents, repositories); resets the runtime AI config (execution mode / provider) to the `.env` defaults; then re-syncs the configured git checkouts and re-indexes the configured knowledge sources.

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
- In `direct` mode → `200` with `{ "mode": "direct", "questionId": "...", "result": { ... } }`,
  where `result` is an `AnswerResult` (answer, confidence, citations, optional gap signal).
- In `queue` mode → `202` with `{ "mode": "queue", "questionId": "...", "job": { ... }, "links": { ... } }`.
  An `answer_question` job is enqueued for a watcher and the question log is written immediately
  with unknown confidence. See [question-logging.md](question-logging.md).

### `GET /api/knowledge/search?q=<query>&limit=<n>`

Searches indexed sections. `limit` defaults to `5`. When hybrid retrieval is active (Postgres + embeddings configured), results are ranked by Reciprocal Rank Fusion of pgvector nearest-neighbour and keyword scores; otherwise keyword scoring is used. Each result carries a `[0,1]` relevance score.

- `400 query_required` — missing `q`.
- `200` — `{ "sections": [ DocumentSection, ... ] }`.

### `POST /api/knowledge/repositories/index`

Indexes the destination KB for a configured flow. See [ingestion.md](ingestion.md).

```json
{ "flowId": "cats" }
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

Both fields are optional and override the flow's defaults when supplied. The response is the draft
outcome — in direct mode `{ "ok": true, "mode": "direct", "proposal": Proposal }`, in queue mode
`{ "ok": true, "mode": "queue", "job": AiJob }`.

- `404 cluster_not_found` — no active cluster with that id.

## Proposals

See the Proposal Review and Storage sections in [ai-jobs.md](ai-jobs.md).

### `GET /api/proposals?limit=<n>`

Lists proposals. `limit` defaults to `50`.

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
- `202` — `{ "job": AiJob, "links": { "job": "/api/jobs/:id", "wait": "/api/jobs/:id/wait", "cancel": "/api/jobs/:id/cancel", "proposals": "/api/proposals" } }`.

### `GET /api/proposals/:id`

- `404 proposal_not_found`.
- `200` — `{ "proposal": Proposal }`.

### `POST /api/proposals/:id/status`

Sets the proposal status directly. Valid values: `draft`, `ready`, `branch-pushed`,
`pr-opened`, `merged`, `rejected`.

```json
{ "status": "ready" }
```

- `400 valid_proposal_status_required`.
- `404 proposal_not_found`.
- `200` — `{ "proposal": Proposal }`.

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
- `202` — `{ "job": AiJob, "links": { "job": "/api/jobs/:id", "wait": "/api/jobs/:id/wait", "cancel": "/api/jobs/:id/cancel", "proposal": "/api/proposals/:id" } }`.

### `GET /api/proposals/:id/execution-context`

The non-generative, credential-free context the watcher publication runner fetches before executing
git. Returns the proposal record plus the resolved repository config it needs to push a branch and
open a PR (`id`, `localPath`, `remoteUrl`, `defaultBranch`, `git`). Never returns credentials. Runs
the same repository resolution + validation as the publish path.

- `404 proposal_not_found`.
- `409 proposal_repository_not_found` — no indexed repository matches the target path.
- `409 proposal_repository_not_git` — the matched repository is not a Git checkout.
- `200` — `{ "proposal": Proposal, "repository": { "id", "localPath", "remoteUrl"?, "defaultBranch", "git"? } }`.

## AI Jobs

The full job contract — payload shapes, the watcher model, and provider configuration — lives
in [ai-jobs.md](ai-jobs.md). Job types: `answer_question`, `summarize_gap`,
`draft_markdown_proposal`, `detect_contradiction`, `suggest_consolidation`.

### `POST /api/ai-jobs`

Creates a job.

```json
{ "type": "draft_markdown_proposal", "input": { ... } }
```

- `400 valid_job_type_required` — unknown or missing type.
- `201` — `{ "job": AiJob }`.

### `GET /api/ai-jobs`

Lists all jobs.

```json
{ "jobs": [ AiJob, ... ] }
```

### `GET /api/ai-jobs/:id`

- `404 job_not_found`.
- `200` — `{ "job": AiJob }`.

### `POST /api/ai-jobs/claim`

Claims the oldest pending job matching the worker's accepted types.

```json
{ "workerName": "local-dev-watcher", "acceptedTypes": ["answer_question", "draft_markdown_proposal"] }
```

- `400 worker_name_required`.
- `400 accepted_types_required` — none of the supplied types are recognised.
- `200` — `{ "job": AiJob }` or `{ "job": null }` when nothing is pending.

### `POST /api/ai-jobs/:id/complete`

Completes a claimed job. On completion the API updates the originating question log
(`answer_question`) or stores the generated proposal (`draft_markdown_proposal`).

```json
{ "output": { ... } }
```

- `404 job_not_found`.
- `500 job_completion_failed` — `message` carries the reason.
- `200` — `{ "job": AiJob }`.

### `POST /api/ai-jobs/:id/fail`

Marks a job as failed.

```json
{ "error": "Provider timed out" }
```

- `404 job_not_found`.
- `200` — `{ "job": AiJob }`.

## Type Reference

The response shapes referenced above (`AnswerResult`, `Citation`, `DocumentSection`,
`KnowledgeDocument`, `RepositoryRef`, `QuestionLog`, `GapCandidate`, `Proposal`,
`ProposalPublication`, `AiJob`) are defined in `packages/core/src/index.ts`.
