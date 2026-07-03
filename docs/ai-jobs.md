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

- `POST /api/jobs/claim` — claim the oldest claimable job matching the worker's
  capabilities: `{ "workerName": "local-dev-watcher", "capabilities": ["openai-compatible", "maintenance"] }`.
  Returns `{ "job": JobView }` or `{ "job": null }`.
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
When the watcher completes that job, the API stores the generated Markdown proposal for review. The proposal's
file location is derived from the destination — `<destination docs subpath>/<title-slug>.md` — so it is consistent
across providers; any `targetPath` returned by the provider is not used to place the file.

```bash
curl -s http://localhost:4000/api/proposals
```

A proposal moves through a status lifecycle: `draft`, `ready`, `branch-pushed`, `pr-opened`,
`merged`, `rejected`. Update it directly:

```bash
POST /api/proposals/:id/status
{ "status": "ready" }
```

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
PR to open) and the console's Merge action completes the publish. It reports the result back via job
completion — which records the branch, commit SHA, and (for GitHub) PR URL on the proposal. Invalid
publishes fail fast with the same `404`/`409` codes before any job is created.

## Seeding a flow

The demand-driven pipeline above (question → gap → cluster → proposal) is how knowledge
*evolves* from real usage. To **bootstrap** a new flow — or add a whole new area of knowledge
(e.g. a new feature) to an existing one — there is a direct authoring path that skips the
gap-clustering and intent-inference half entirely:

```json
POST /api/flows/:flowId/seed
{
  "items": [
    { "title": "Billing overview", "coverage": ["what billing is", "the plans"] },
    { "coverage": ["refund policy", "how to request a refund"] }
  ]
}
```

Each *item* (a title plus the points it should cover) is drafted directly into a
`draft_seed_document` AI job, grounded in the flow's source material. On completion the API
creates a clusterless proposal carrying the flow's id first-class and reconciles it through the
shared gate: a seed doc that overlaps an open PR on the same path folds into it, otherwise it
self-publishes as its own PR. So seeding still ends at a reviewable pull request — the same
human gate as everything else — but without the `reconcile_gap_clusters` job, the intent gate,
or the maintenance-cron wait. The endpoint requires the `manage:jobs` scope (and `manage` on
the target flow) and returns the enqueued job ids.

The same operation is exposed over MCP as the `kb.seed` tool, so an interviewer LLM can submit
a finished outline in one shot rather than streaming questions into `kb.ask` and waiting for
the gap pipeline.

### Generating the outline (`outline_flow_seed`)

Writing the `items` list by hand (or via an external interviewer LLM) is not the only way to
produce it. The `outline_flow_seed` AI job **proposes** the list from a topic:

```json
POST /api/flows/:flowId/outline
{ "topic": "Refund handling", "notes": "focus on partial refunds" }
```

The API grounds the job in the flow's *existing* docs — it retrieves the closest destination
sections for the topic (inline embeddings, the same mechanism the gap reconciler uses for scope
grounding) and passes them as context along with the flow persona — so the model proposes
documents that fit the current structure and don't restate what's already covered. The job
returns `{ items: SeedItem[], rationale }`; it **only proposes** and drafts nothing. Its output
rides on the job record (read it back via `GET /api/jobs/:id/wait`), so there is no completion
side-effect and no new stored entity. The endpoint requires the `manage:jobs` scope (and
`manage` on the target flow) and returns the enqueued job id.

The full path is: **topic → `outline_flow_seed` (retrieval-grounded) → human edits/approves the
proposed `items` → `POST /flows/:id/seed`** (the direct authoring path above). This is what the
console's **Seed / add an area** page drives — pick a flow, enter a topic, *Generate outline*,
edit the proposed documents, then *Seed*. The generated PRs flow into the normal review queue.

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

Use `STORAGE_BACKEND=postgres` for local development and deployments.

Jobs and schedules are owned entirely by pg-boss (the `JobBroker`), which manages its own
Postgres tables. The legacy custom job table and its queue-selection override have been
removed. pg-boss handles claiming, retries, and overlap protection so multiple watchers can
safely poll the same queues once the API is running against a real database.
