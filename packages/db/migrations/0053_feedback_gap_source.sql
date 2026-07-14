-- 'unhelpful' feedback on a confident (high/medium) live answer now raises a
-- server-side 'feedback' gap (#241): the user rejected an answer the system
-- believed in — a strong quality signal that previously went nowhere. Like
-- 'verification', the source is written by the API only (the answer_question
-- output schema stays narrow to auto/manual/followup); the gap joins candidate
-- clustering and drafting exactly as followup misses do, and flipping the
-- feedback back to 'helpful' withdraws the live row. Widen the CHECK to admit
-- the new source. Additive; existing rows keep their source.
ALTER TABLE question_gaps DROP CONSTRAINT IF EXISTS question_gaps_source_check;
ALTER TABLE question_gaps
  ADD CONSTRAINT question_gaps_source_check
  CHECK (source IN ('auto', 'manual', 'followup', 'verification', 'feedback'));
