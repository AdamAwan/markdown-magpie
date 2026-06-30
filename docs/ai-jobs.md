# AI Job Contract

AI work is represented as jobs on a pg-boss queue in Postgres so Markdown Magpie
can use hosted model APIs or external tools such as Codex and Claude Code. The
API enqueues jobs; a watcher claims and completes them. The API never runs a
model inline.

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
commits the Markdown to a new `magpie/proposal-*` branch, pushes it, and opens a pull request, then
reports the result back via job completion — which records the branch, commit SHA, and PR URL on the
proposal. Invalid publishes fail fast with the same `404`/`409` codes before any job is created.

## Crunch — scheduled knowledge-base tidying

Crunch is a scheduled maintenance pass that fights knowledge-base fragmentation:
it consolidates overlapping documents and splits bloated, multi-topic documents,
then lands the result on a review branch.

It uses the `crunch_knowledge_base` job type. The input is every document
(path + content) for a flow's destination; the output is a `CrunchPlan` — a list
of operations, each with the source paths it reorganizes, the files to write, and
the files to delete:

```json
{
  "summary": "2 tidy operation(s): 1 split, 1 consolidate.",
  "operations": [
    {
      "kind": "split",
      "title": "Split docs/big.md into 3 focused documents",
      "reason": "...",
      "sources": ["docs/big.md"],
      "writes": [{ "path": "docs/big/setup.md", "content": "..." }],
      "deletes": ["docs/big.md"]
    }
  ],
  "rationale": "..."
}
```

The API enqueues a `crunch_knowledge_base` job and the watcher completes it,
matching the rest of the job contract.

A run is triggered manually (`POST /api/crunch/run`) or on a schedule. The
schedule is configured per flow via `POST /api/crunch/settings`
(`{ flowId, enabled, cron }`). The saved settings are reconciled into pg-boss
schedules, which enqueue a `trigger_scheduled_crunch` job on the cron; the
maintenance watcher runs it. Endpoints:

- `GET /api/crunch/runs` — list recent runs and their plans.
- `POST /api/crunch/run` — trigger a run now (`{ flowId }`).
- `GET /api/crunch/settings` / `POST /api/crunch/settings` — read/update the schedule.
- `POST /api/crunch/runs/:id/publish` — commit a completed run's plan (multi-file
  writes and deletes) to a new `magpie/crunch-*` branch via the `local-git`
  publisher and open a pull request for it (the run records the PR url alongside
  the branch and commit; a PR failure degrades to a branch-only publish).

Crunch state is stored in the `crunch_runs` and `crunch_settings` tables
(`STORAGE_BACKEND=postgres`), with in-memory fallbacks for local development.
Run timing is owned by pg-boss (next-run is derived from the cron and surfaced
on `GET /api/crunch/settings`), not tracked in the settings tables. Schedules
fire in `JOB_SCHEDULE_TIMEZONE` (default `UTC`).

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
| `github` | `GITHUB_TOKEN`, `MAGPIE_GIT_AUTHOR_NAME`, `MAGPIE_GIT_AUTHOR_EMAIL` |
| `maintenance` | (none) |

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
