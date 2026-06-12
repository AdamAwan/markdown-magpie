ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS gap_summary text,
  ADD COLUMN IF NOT EXISTS triggering_question_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS rationale text,
  ADD COLUMN IF NOT EXISTS job_id text;

CREATE INDEX IF NOT EXISTS proposals_created_at_idx ON proposals (created_at DESC);
CREATE INDEX IF NOT EXISTS proposals_job_id_idx ON proposals (job_id) WHERE job_id IS NOT NULL;
