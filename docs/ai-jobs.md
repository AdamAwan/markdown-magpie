# AI Job Contract

AI work is represented as queueable jobs so Markdown Magpie can use hosted model APIs, local mock runners, or external tools such as Codex and Claude Code.

## Endpoints

### `POST /api/ai-jobs`

Creates a job.

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

### `POST /api/ai-jobs/claim`

Claims the oldest pending job matching the worker's accepted types.

```json
{
  "workerName": "local-dev-watcher",
  "acceptedTypes": ["answer_question", "summarize_gap", "draft_markdown_proposal"]
}
```

Returns:

```json
{
  "job": null
}
```

or:

```json
{
  "job": {
    "id": "...",
    "type": "answer_question",
    "status": "claimed",
    "input": {}
  }
}
```

### `POST /api/ai-jobs/:id/complete`

Completes a claimed job.

```json
{
  "output": {
    "answer": "I could not find reliable source material for this question.",
    "confidence": "low",
    "citations": []
  }
}
```

### `POST /api/ai-jobs/:id/fail`

Marks a job as failed.

```json
{
  "error": "Provider timed out"
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

In `direct` mode the API plans synchronously (the `mock` provider uses a
deterministic size/fragmentation heuristic). In `queue` mode a job is enqueued
and the watcher completes it, matching the rest of the job contract.

A run is triggered manually (`POST /api/crunch/run`) or by the in-process
scheduler. The scheduler is configured per flow via `POST /api/crunch/settings`
(`{ flowId, enabled, intervalMinutes }`) and fires on an interval. Endpoints:

- `GET /api/crunch/runs` — list recent runs and their plans.
- `POST /api/crunch/run` — trigger a run now (`{ flowId }`).
- `GET /api/crunch/settings` / `POST /api/crunch/settings` — read/update the schedule.
- `POST /api/crunch/runs/:id/publish` — commit a completed run's plan (multi-file
  writes and deletes) to a new `magpie/crunch-*` branch via the `local-git` publisher.

Crunch state is stored in the `crunch_runs` and `crunch_settings` tables
(`STORAGE_BACKEND=postgres`), with in-memory fallbacks for local development.
The scheduler tick interval defaults to 60s and can be tuned with
`CRUNCH_SCHEDULER_TICK_MS`.

## Watcher Model

The watcher has no direct database access. It talks to the API only:

1. Claim a job.
2. Run a provider-specific adapter.
3. Complete or fail the job.
4. Poll again.

This keeps Codex, Claude Code, hosted APIs, and local mock providers behind the same contract.

## External Agent Providers

The watcher can run a local CLI as the AI provider.

Use `AI_PROVIDER` for both direct and queued AI providers. `AI_JOB_PROVIDER` is still
accepted as an older compatibility name, but new local and deployment configuration should
prefer `AI_PROVIDER`.

Mock watcher:

```bash
AI_EXECUTION_MODE=queue AI_PROVIDER=mock npm run dev:api
AI_PROVIDER=mock npm run dev:watcher
```

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
- Add a deterministic `mock` provider for local tests and demos.
- Prefer OpenAI-compatible `/chat/completions` support for broad API coverage.
- Keep provider credentials in environment variables, never in job payloads.
- Use timeouts around external calls and mark jobs failed with readable errors.
- Add one conformance smoke test per provider shape: answer job, gap summary job, and proposal job.

## Storage

Use `STORAGE_BACKEND=postgres` for local development and deployments. AI jobs are stored in
Postgres tables, including `ai_jobs`.

The older `AI_JOB_QUEUE` variable still works as a compatibility override for the job queue only.

Postgres claiming uses `FOR UPDATE SKIP LOCKED`, so multiple watchers can safely poll the same queue once the API is running against a real database.
