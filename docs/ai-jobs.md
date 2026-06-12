# AI Job Contract

AI work is represented as queueable jobs so Markdown Magpie can use hosted model APIs, local mock runners, or external tools such as Codex and Claude Code.

## Endpoints

### `POST /ai-jobs`

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

### `POST /ai-jobs/claim`

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

### `POST /ai-jobs/:id/complete`

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

### `POST /ai-jobs/:id/fail`

Marks a job as failed.

```json
{
  "error": "Provider timed out"
}
```

## Proposal Review

Gap candidates can be turned into proposal jobs:

```json
POST /proposals/from-gap
{
  "summary": "No source material found for: How do I trim claws?",
  "targetPath": "knowledge-bases/cats/proposed-gap.md"
}
```

The API enqueues a `draft_markdown_proposal` job with the triggering questions and any available evidence citations.
When the watcher completes that job, the API stores the generated Markdown proposal for review.

```bash
curl -s http://localhost:4000/proposals
```

## Watcher Model

The watcher has no direct database access. It talks to the API only:

1. Claim a job.
2. Run a provider-specific adapter.
3. Complete or fail the job.
4. Poll again.

This keeps Codex, Claude Code, hosted APIs, and local mock providers behind the same contract.

## External Agent Providers

The watcher can run a local CLI as the AI provider.

Mock watcher:

```bash
AI_EXECUTION_MODE=queue npm run dev:api
AI_JOB_PROVIDER=mock npm run dev:watcher
```

OpenAI-compatible API watcher:

```bash
AI_JOB_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1 \
OPENAI_COMPATIBLE_API_KEY=... \
OPENAI_COMPATIBLE_MODEL=... \
npm run dev:watcher
```

Codex-style command:

```bash
AI_JOB_PROVIDER=codex \
CODEX_CLI_PATH=codex \
CODEX_CLI_ARGS=exec \
CODEX_CLI_PROMPT_MODE=arg \
npm run dev:watcher
```

Claude-style command:

```bash
AI_JOB_PROVIDER=claude \
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

The API supports two queue backends:

- `AI_JOB_QUEUE=memory`: process-local storage for fast development and tests.
- `AI_JOB_QUEUE=postgres`: durable storage using the `ai_jobs` table.

Postgres claiming uses `FOR UPDATE SKIP LOCKED`, so multiple watchers can safely poll the same queue once the API is running against a real database.
