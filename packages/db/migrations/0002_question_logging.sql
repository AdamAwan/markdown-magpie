ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'mock',
  ADD COLUMN IF NOT EXISTS chat_provider text NOT NULL DEFAULT 'mock',
  ADD COLUMN IF NOT EXISTS gap_summary text,
  ADD COLUMN IF NOT EXISTS feedback text,
  ADD COLUMN IF NOT EXISTS feedback_at timestamptz,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

ALTER TABLE answer_citations
  ADD COLUMN IF NOT EXISTS document_id text,
  ADD COLUMN IF NOT EXISTS path text,
  ADD COLUMN IF NOT EXISTS heading text,
  ADD COLUMN IF NOT EXISTS anchor text;

CREATE INDEX IF NOT EXISTS questions_confidence_asked_at_idx ON questions (confidence, asked_at DESC);
CREATE INDEX IF NOT EXISTS questions_gap_summary_idx ON questions (gap_summary) WHERE gap_summary IS NOT NULL;
