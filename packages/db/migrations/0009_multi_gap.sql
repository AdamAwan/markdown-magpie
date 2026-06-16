-- A question can expose several distinct knowledge gaps. Move from the single
-- questions.gap_summary column to a child table that holds one row per gap, so
-- multi-topic questions cluster and become proposals per gap rather than as one
-- condensed summary. 'source' records whether the gap was auto-detected during
-- answer synthesis or flagged manually by an admin.
CREATE TABLE IF NOT EXISTS question_gaps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id text NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  summary text NOT NULL,
  source text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS question_gaps_question_idx ON question_gaps (question_id);
CREATE INDEX IF NOT EXISTS question_gaps_summary_idx ON question_gaps (summary);

-- Backfill existing single gaps. A manually-flagged question's summary becomes a
-- 'manual' gap; everything else is an auto-detected gap.
INSERT INTO question_gaps (question_id, summary, source)
SELECT id, gap_summary, CASE WHEN manual_gap THEN 'manual' ELSE 'auto' END
FROM questions
WHERE gap_summary IS NOT NULL AND btrim(gap_summary) <> '';

-- The scalar column (and its partial index) are superseded by question_gaps.
DROP INDEX IF EXISTS questions_gap_summary_idx;
ALTER TABLE questions DROP COLUMN IF EXISTS gap_summary;
