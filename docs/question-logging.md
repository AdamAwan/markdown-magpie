# Question Logging

Markdown Magpie records question interactions so the knowledge base can learn from usage.

## Stores

- `STORAGE_BACKEND=postgres`: durable logs in Postgres.

`QUESTION_LOG_STORE` still works as a compatibility override for question logs, but new local and deployment configs should prefer `STORAGE_BACKEND`.

## Logged Fields

Each question log records:

- Question text.
- Chat provider that produced the answer.
- Confidence.
- Retrieved section IDs.
- Flow the question was routed to, when known.
- Answer result.
- Citations.
- Gaps, when present. A single question can record several gaps — each
  distinct unanswered topic is its own gap, tagged `auto` (detected during
  answer synthesis) or `manual` (flagged by an admin).
- Helpful or unhelpful feedback, when submitted.
- Manual knowledge-gap flag, when set.
- Timestamp.

## Endpoints

```bash
GET /api/questions
GET /api/questions/:id
POST /api/questions/:id/feedback
POST /api/questions/:id/gap
DELETE /api/questions/:id/gap
GET /api/gaps/candidates
```

Gap candidates are grouped by gap summary, across the individual gaps of every question. Answer synthesis asks the model to return structured JSON with `isKnowledgeGap` and a `gaps` array of summaries; when `isKnowledgeGap` is true, the answer is logged as low confidence and each summary becomes its own gap eligible for grouping. This means a single multi-topic question — for example "how do I set this up with React so I can export dashboards?" — records one gap per unanswered topic, so each can cluster with the same gap from other questions and become its own proposal, rather than being condensed into one summary. (The model may still return a single gap, or the legacy singular `gapSummary` string, which is wrapped into a one-element array.)

Gaps can also be flagged manually — via the **Knowledge gap** chip in the console, or the MCP `kb.feedback` tool — when the system fails to detect one automatically. A manual flag is separate from helpful/unhelpful feedback (an answer can be helpful and still expose a gap), and a manually-flagged question joins the same gap-candidate clustering and proposal workflow regardless of its answer confidence. Manual flagging adds a `manual` gap (its summary falls back to the question text) alongside any auto-detected gaps; clearing the flag removes only the manual gap and leaves auto-detected gaps intact.

## Queued Answers

Every answer runs through the queue. When a question is asked, the API logs it
immediately with unknown confidence and enqueues an `answer_question` job
carrying the question log ID. A watcher routes the question to a flow, retrieves
context, synthesises the answer, and completes the job; completion updates the
log with the answer, confidence, chosen flow, and any detected gaps.
