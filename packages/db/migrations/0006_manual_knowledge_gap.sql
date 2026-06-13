ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS manual_gap boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_gap_at timestamptz;

CREATE INDEX IF NOT EXISTS questions_manual_gap_idx ON questions (manual_gap) WHERE manual_gap = true;
