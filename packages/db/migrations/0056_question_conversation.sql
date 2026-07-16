-- Multi-turn ask (#239). A question can now belong to a conversation: the API
-- mints a conversation_id on the first turn and threads it through follow-ups so
-- prior Q&A turns can be reconstructed (bounded) and fed to the answer_question
-- job for query condensation and sticky routing.
--
-- conversation_id groups the live question logs of one thread. Indexed with
-- asked_at so reconstructing the last N turns of a conversation is a cheap
-- ordered scan.
--
-- standalone_question stores the condensed, self-contained form of a follow-up
-- (e.g. "what about the EU?" -> "What is the data retention policy for the EU
-- region?") that the watcher reports on completion. Gap candidacy and clustering
-- fall back to it instead of the terse raw question so partial follow-up text
-- does not pollute the gap corpus.
--
-- Both columns are nullable and additive: existing rows (legacy questions,
-- verification re-asks, questionnaire items) keep NULL and behave exactly as
-- before — a NULL conversation_id simply means "not part of a thread".
ALTER TABLE questions ADD COLUMN IF NOT EXISTS conversation_id uuid;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS standalone_question text;

CREATE INDEX IF NOT EXISTS questions_conversation_id_asked_at_idx
  ON questions (conversation_id, asked_at)
  WHERE conversation_id IS NOT NULL;
