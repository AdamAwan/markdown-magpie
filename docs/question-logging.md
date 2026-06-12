# Question Logging

Markdown Magpie records question interactions so the knowledge base can learn from usage.

## Stores

- `QUESTION_LOG_STORE=memory`: process-local logs for development.
- `QUESTION_LOG_STORE=postgres`: durable logs in Postgres.

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
- Timestamp.

## Endpoints

```bash
GET /questions
GET /questions/:id
GET /gaps/candidates
```

Gap candidates are currently grouped from low-confidence questions with a gap summary. This is intentionally simple; clustering can build on top of this data.

## Queued Answers

When `AI_EXECUTION_MODE=queue`, the API logs the queued question immediately with unknown confidence. The `answer_question` job includes the question log ID, and the API updates the log when the watcher completes the job.
