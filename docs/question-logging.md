# Question Logging

Markdown Magpie records question interactions so the knowledge base can learn from usage.

## Stores

- `STORAGE_BACKEND=memory`: process-local logs for development.
- `STORAGE_BACKEND=postgres`: durable logs in Postgres.

`QUESTION_LOG_STORE` still works as a compatibility override for question logs, but new local and deployment configs should prefer `STORAGE_BACKEND`.

## Logged Fields

Each question log records:

- Question text.
- Execution mode.
- Chat provider or watcher.
- Confidence.
- Retrieved section IDs.
- Answer result.
- Citations.
- Gap signal, when present.
- Helpful or unhelpful feedback, when submitted.
- Timestamp.

## Endpoints

```bash
GET /questions
GET /questions/:id
POST /questions/:id/feedback
GET /gaps/candidates
```

Gap candidates are currently grouped from low-confidence questions with a gap summary. This is intentionally simple; clustering can build on top of this data.

## Queued Answers

When `AI_EXECUTION_MODE=queue`, the API logs the queued question immediately with unknown confidence. The `answer_question` job includes the question log ID, and the API updates the log when the watcher completes the job.
