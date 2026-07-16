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
providers), the parsed `AI_PRICING` token-price table (`aiPricing.entries`, echoed
verbatim — prices are not secrets, and this is how an operator verifies the table the
API actually loaded), watcher settings, and retrieval settings including
`retrieval.mode` (`hybrid` or `keyword`) and a plain-language `reason`.

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

### `GET /api/knowledge/sections/:id`

Resolves one indexed section in full — the lookup behind MCP's `kb_citation`, which expands a citation's excerpt into the complete evidence passage.

- `404 section_not_found` — the id is not in the index (e.g. the section was re-indexed away).
- `200` — `{ "section": DocumentSection }`.

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

### `GET /api/questions?limit=<n>&offset=<n>&q=<text>`

Lists question logs (newest first), paginated. `limit` defaults to `50` (capped at
`200`), `offset` to `0`. `q` (optional) narrows the list to questions whose text
contains it — a case-insensitive literal substring, not a pattern. `total` is the
unpaginated count of all listable (live) questions; `matching` is the count within
the `q` filter (equal to `total` when `q` is absent), so `offset` pages within the
matches. The console's Ask page drives its search box and Newer/Older pager off
this: the pager walks `matching`, the sidebar badge shows `total`.

```json
{ "questions": [ QuestionLog, ... ], "total": 123, "matching": 7 }
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

`unhelpful` on a **confident** (high/medium) live answer additionally raises a server-side
`feedback` gap — the user rejected an answer the system believed in, which enters gap candidacy
the way followup misses do (see [question-logging.md](question-logging.md)). Flipping the
feedback back to `helpful` withdraws the live feedback gap. Low/unknown-confidence answers raise
no feedback gap (their misses already record `auto` gaps).

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

Lists knowledge-gap candidates grouped by gap summary. Candidacy keys on the question's unresolved gap rows, not its answer confidence: `auto` gaps (a declared whole-question miss — the answer ships at `low`, or at `medium` for a substantive partial answer), `followup` gaps (raised alongside confident answers), and `manual` flags all qualify. `limit` defaults to `50`.

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

## Seeding (plans)

Seeding is plan-centric — see the Seeding section in [ai-jobs.md](ai-jobs.md#seeding-a-flow)
for the full lifecycle. All seeding routes require the `manage:jobs` scope plus `manage` on
the plan's flow; unknown/cross-flow ids read as `404`.

### `POST /api/flows/:flowId/outline`

Proposes a seed plan: enqueues the source-grounded `outline_flow_seed` planning job (no
topic — the body is `{ "notes"?: string }`, an optional steer for this run). Enqueue-only:
returns `{ "ok": true, "jobId": string, "reused": boolean }`; `reused: true` means an
outline run for this flow was already in flight and its job id was returned instead. The
persisted plan is created by the job's completion handler.

### `GET /api/flows/:flowId/seed-plans` · `GET /api/seed-plans/:id`

List a flow's plans (newest first, `{ "plans": [SeedPlan, ...] }`) or fetch one
(`{ "plan": SeedPlan }`). A `SeedPlan` carries `{ id, flowId, status, origin, charter?,
persona?, charterProposed, personaProposed, items, rationale, notes?, outlineJobId,
sourceHash, createdAt, updatedAt }`; each item has a stable `id`, a per-item `status`
(`proposed | approved | dismissed`) and, once approval enqueued its draft, a `draftJobId`.

### `PATCH /api/seed-plans/:id`

Reviewer edits — `{ "charter"?, "persona"?, "items"?: [{ id, title?, targetPath?,
coverage?, questions?, status? }] }`. Only while the plan is `proposed`; afterwards
`409 plan_not_editable`.

### `POST /api/seed-plans/:id/approve`

Flips the plan to `approved` and enqueues one `draft_seed_document` per non-dismissed item
(carrying the plan's run-scoped charter/persona and `seedPlanId`). Returns
`{ "plan": SeedPlan, "jobIds": string[] }`. Replay-safe: items that already recorded a
`draftJobId` are skipped, so re-approving after a mid-loop enqueue failure completes the
remainder. `400 coverage_required` when an approvable item has no coverage;
`409 plan_not_approvable` for dismissed/superseded plans.

### `POST /api/seed-plans/:id/dismiss`

Dismisses a `proposed` plan (`409 plan_not_dismissable` otherwise). Dismissal is sticky for
the sparse-flow bootstrap: the plan's source hash suppresses re-proposal until the flow's
sources change.

### `POST /api/flows/:flowId/seed-bootstrap/run`

Thin orchestration endpoint the maintenance watcher's `seed_bootstrap` runner POSTs (rate
limited on the trigger tier). Checks the sparse-flow guards and, when they all pass,
enqueues an auto-origin planning run. Returns
`{ "enqueued": boolean, "reason"?: string, "outlineJobId"?: string }` — `reason` names the
guard that no-oped the tick (`no_sources | kb_populated | plan_pending | outline_in_flight
| seed_proposals_open | dismissed_unchanged`).

> The legacy raw-items `POST /api/flows/:flowId/seed` endpoint is **removed** — plan
> approval is the only drafting entry point.

## Questionnaires

Bulk question batches with verbatim answer reuse — see [questionnaires.md](questionnaires.md)
for the model (match → two-condition reuse check → drip → approve → export).

### `POST /api/questionnaires`

`{ "name": string, "flowId": string, "questions": string[] }` (1–500 questions). Creates the
batch, runs matching + reuse checks inline (embeddings only), and starts the answer drip.
Returns `201 { "questionnaire": Questionnaire }`. `404 flow_not_found` for an unknown flow;
`ask:knowledge` scope + flow `ask` capability; `trigger` rate tier.

### `GET /api/questionnaires` / `GET /api/questionnaires/:id`

Summaries (with per-status counts) / the full worksheet. Reading a worksheet also resumes a
stalled answer drip. `read:knowledge` + flow `read`; unknown or cross-flow ids read as 404.

### `GET /api/questionnaires/:id/export?format=md|csv`

The worksheet as a downloadable Markdown or CSV file.

### `POST /api/questionnaires/:id/items/:itemId/approve` / `POST /api/questionnaires/:id/approve-reused`

Approve one answered item (409 `not_answered` otherwise) or every reused item. Approval
admits the answer into the match corpus for future questionnaires and snapshots its citation
fingerprints. `manage:knowledge` + flow `manage`.

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

### `POST /api/proposals/bulk`

One review action applied across many proposals — the console's bulk bar. Outcomes are
strictly **per id**: a bad id (unknown, cross-flow, wrong status, PR-tracked) is reported
for that id and never fails the rest of the batch, so the response is always `200` with a
results array (`400` only for a malformed body). Ids are processed sequentially so a batch
of local-git merges contends for the destination checkout lock one at a time.

```json
{ "action": "ready", "ids": ["<proposal-id>", "..."] }
```

`action` is one of `ready`, `publish`, `merge`, `reject`; `ids` holds 1–100 proposal ids.
Each id composes the matching single-item behaviour:

- `ready` — `draft → ready`; any other status reports `invalid_status`.
- `publish` — enqueue-only publication of a `ready` proposal (the same pre-flight and
  `publish_proposal` job as `POST /:id/publish`); the per-id result carries the `job`. Like the
  single route, a proposal whose publish is already in flight reuses that job rather than
  enqueueing a duplicate.
- `merge` — local-git `branch-pushed` proposals git-merge exactly like `POST /:id/merge`;
  hosted `branch-pushed` proposals without a pull request take the manual no-PR merge of
  `POST /:id/status`. A proposal with a live pull request reports
  `proposal_merge_tracked_by_pull_request` (its merge is owned by the PR poller). The merge
  cascade is scheduled once per newly-merged id — a retried batch cannot re-run it.
- `reject` — local-git `branch-pushed` proposals are binned like `POST /:id/reject`;
  hosted `draft` proposals are marked `rejected`.

Per-id auth mirrors the single routes: an id the caller cannot read reports
`proposal_not_found` (no cross-flow enumeration); readable but lacking `manage` on the
flow reports `forbidden`.

- `400 valid_bulk_action_required` — malformed body (unknown action, 0 or >100 ids).
- `200` — `{ "results": [ { "id": string, "ok": boolean, "code"?: string, "proposal"?: Proposal, "job"?: Job }, ... ] }`.

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

Publication is **idempotent while queued**: the proposal record stays `ready` until the watcher
completes, so a repeated publish request (double click, bulk re-select, replayed completion side
effect) returns the in-flight `publish_proposal` job for the proposal instead of enqueueing a
duplicate. A new job is only created once the previous one settles (completed, failed, or
cancelled). The console mirrors this by disabling Publish and showing "Publish queued" while a
publish job for the proposal is in flight.

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
fail takes a structured `error` object. Complete takes `{ "output", "executor"?,
"usage"?, "provider"?, "model"? }` — usage is the run's summed provider-reported token
spend (#241), and provider/model are the executing runner's identity so that spend can
be priced per model; all three are best-effort telemetry (malformed values are dropped,
never a 400). See [ai-jobs.md](ai-jobs.md).

### `GET /api/source-map?sourceIds=…`

Retrieves navigation hints for source-grounded job execution. Query parameter `sourceIds`
is required and accepts a comma-separated list of source IDs to fetch hints for.

Scope: `manage:jobs`. Read cap: 100 entries per requested source per request.

**Response (200):**

```json
{
  "entries": [
    {
      "id": "b0c1…",
      "sourceId": "agent",
      "topic": "authentication flow",
      "paths": ["src/auth/login.ts", "src/auth/oauth.ts"],
      "description": "OAuth2 login and token refresh implementation",
      "observedSha": "abc123de",
      "consensusCount": 3,
      "createdAt": "2026-07-01T12:00:00.000Z",
      "updatedAt": "2026-07-08T09:30:00.000Z"
    }
  ]
}
```

`consensusCount` is how many agents have independently contributed the same
topic → paths mapping (capped at 5) — a credibility signal, not currency.

**Error cases:**

- `400 missing_source_ids` — `sourceIds` query parameter is missing.
- `400 invalid_source_ids` — `sourceIds` is malformed (e.g. not comma-separated).

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

### `GET /api/insights/journey?from&to&flow`

Branching question-journey Sankey: a `{ nodes, links }` graph of the path a question takes over
the window — from being asked (split by `questions.confidence`) through gaps, clusters, proposals,
and merge/verification — where each link's `value` is a real count and the branches show where
volume leaks at each stage. Four segments, each windowed on its own entry timestamp: **answer**
(questions on `questions.asked_at`, each confidence into "no gap" or into the gap segment),
**gap** (gaps on `question_gaps.created_at`, partitioned into dismissed / parked / clustered /
open by their terminal columns and an active `gap_cluster_memberships` row), **proposal**
(proposals on `proposals.created_at`, split by `status` into in-progress / rejected / superseded /
merged), and **verify** (merged proposals split by `closure_status`). The unit of flow shifts
question → gap → proposal at the segment boundaries; each segment is internally conserved. Only
positive-value links (and the nodes they reference) are returned.

- `400 invalid_insights_query` — malformed query.
- `200` — `{ "nodes": JourneyNode[], "links": JourneyLink[] }` (`JourneySankey`).

### `GET /api/insights/jobs/throughput?from&to&bucket&type`

Job throughput & health. Buckets pg-boss jobs by their `created_on` timestamp and splits them into
`completed` / `failed` / `active` / `retry` counts per bucket. pg-boss v12 keeps every job — live and
finished — in the partitioned `"<schema>".job` table until retention purges it (there is no separate
`archive` table), so the rollup reads `job` alone. `active` folds
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
takes only the window bounds. Source: pg-boss's own `job` table — completed
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
Window-only (no time axis). Source: pg-boss's `job` table — failed rows
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

### `GET /api/insights/feedback?from&to&bucket&flow`

Answer feedback (C10). Returns `{ "totals": FeedbackSummary, "series": FeedbackBucket[] }`,
splitting live questions' helpful/unhelpful feedback overall and per bucket, with
`unhelpfulConfident` calling out the `unhelpful` subset whose answer was confident
(high/medium) — the strongest quality signal (the user rejected an answer the system believed
in; these also raise a `feedback` gap, see `POST /api/questions/:id/feedback`). Windowed and
bucketed on `feedback_at` (when the verdict was given); a question's feedback is single-valued
and mutable, so the series reflects each question's current verdict. Verification re-asks
(`purpose != 'live'`) are excluded. `flow` narrows to a single flow. Source: `questions`
(`feedback`, `feedback_at`, `confidence`).

### `GET /api/insights/ai-usage?from&to`

AI token usage priced into cost (C11, #241). Returns `{ "usage": AiUsageBreakdown[] }`, one
row per (job type, provider, **model**) triple that completed at least one AI job in the
window, ordered by `totalTokens` (heaviest first). `jobs` counts every completed job of the
triple; `jobsWithUsage` counts the subset whose completion carried provider-reported usage.
`estimatedCost` is money, computed at read time from the token sums × the operator's
`AI_PRICING` table (input × `inputPerMTok` + output × `outputPerMTok`, per million) — never
persisted, so correcting a price re-values history. It is present **only** when a price entry
matches the triple's (provider, model); its absence spans two states the caller keeps apart
via `jobsWithUsage` and must never render as `$0`:
- **priced** — `estimatedCost` present.
- **unpriced** — `jobsWithUsage > 0` but no matching price entry (unknown-cost usage).
- **unmetered** — `jobsWithUsage === 0` (CLI providers emit raw text and report nothing).

Window-only (grouped by triple, not time), windowed on `created_on` (enqueue time, matching
C2/C6). Source: pg-boss's `job` table — completed rows on the provider-fanned AI work queues,
whose persisted `{ result, executor, usage?, provider?, model? }` completion envelope carries
the watcher's summed usage and execution identity; the queue-name → (type, provider) mapping
is derived from the `@magpie/jobs` catalog and `model` from `output->>'model'`.

### `GET /api/insights/ai-cost/by-flow?from&to&flow`

Per-flow AI cost. Returns `{ "flows": AiCostByFlow[] }` — the same rollup grouped additionally
by the flowId on the job input (`data->'input'->>'flowId'`), aggregated to one cost summary per
flow, ordered by `estimatedCost` (heaviest first). `flow` narrows to a single flow id (the
shared insights flow-filter convention). Jobs whose input carries no flowId — `answer_question`
and the `fold_*` jobs never do — form the **unattributed** bucket (`flowId` absent). The three
cost states survive as counts: `pricedJobs` (metered jobs that matched a price entry, summed
into `estimatedCost`), `jobsWithUsage − pricedJobs` (unpriced), `jobs − jobsWithUsage`
(unmetered). Window-only. Flow display names are resolved by the console from config, not here.

### `GET /api/insights/ai-cost/by-schedule?from&to`

Per-schedule AI cost (approximate attribution). Returns `{ "schedules": AiScheduleCost[] }` —
each scheduled task's windowed spend, summed over the AI job types its orchestrator fans out to
(the task registry's `aiJobTypes`, derived from the enqueue sites) filtered to the task's own
flow. `key` matches `ScheduledTask.key` so the Schedules page joins it on. Tasks that spend no
model tokens (the GitHub snapshot refresh) are omitted. Attribution is approximate: only job
types that carry a flowId on their input are counted, and second-order proposal folds (triggered
by a later completion, and carrying no flowId) are not attributed. Same three-state cost fields
as `AiCostByFlow`. Window-only.

## Type Reference

The response shapes referenced above (`AnswerResult`, `Citation`, `DocumentSection`,
`KnowledgeDocument`, `RepositoryRef`, `QuestionLog`, `GapCandidate`, `Proposal`,
`ProposalPublication`, `GapBacklogBucket`, `LatencyBin`, `VerificationSummary`,
`VerificationBucket`, `JobErrorBreakdown`, `DocumentFreshness`, `SourceFreshness`,
`FreshnessSummary`, `PatrolImpact`, `AiUsageBreakdown`, `AiCostByFlow`, `AiScheduleCost`) are
defined in `packages/core/src/index.ts`. The `Job`
shape (`JobView`) is defined in `packages/jobs/src/types.ts`.
