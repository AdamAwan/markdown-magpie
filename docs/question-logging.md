# Question Logging

Markdown Magpie records question interactions so the knowledge base can learn from usage.

## Stores

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
- Manual knowledge-gap flag, when set.
- Timestamp.

## Endpoints

```bash
GET /questions
GET /questions/:id
POST /questions/:id/feedback
POST /questions/:id/gap
DELETE /questions/:id/gap
GET /gaps/candidates
```

Gap candidates are grouped by gap summary. Answer synthesis asks the model to return structured JSON with `isKnowledgeGap` and `gapSummary`; when `isKnowledgeGap` is true, the answer is logged as low confidence and becomes eligible for gap grouping.

Gaps can also be flagged manually — via the **Knowledge gap** chip in the console, or the MCP `kb.feedback` tool — when the system fails to detect one automatically. A manual flag is separate from helpful/unhelpful feedback (an answer can be helpful and still expose a gap), and a manually-flagged question joins the same gap-candidate clustering and proposal workflow regardless of its answer confidence. Manual flagging reuses the question's gap summary, falling back to the question text. This is intentionally simple; clustering can build on top of this data.

## Queued Answers

When `AI_EXECUTION_MODE=queue`, the API logs the queued question immediately with unknown confidence. The `answer_question` job includes the question log ID, and the API updates the log when the watcher completes the job.
