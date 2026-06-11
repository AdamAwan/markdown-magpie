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

## Watcher Model

The watcher has no direct database access. It talks to the API only:

1. Claim a job.
2. Run a provider-specific adapter.
3. Complete or fail the job.
4. Poll again.

This keeps Codex, Claude Code, hosted APIs, and local mock providers behind the same contract.
