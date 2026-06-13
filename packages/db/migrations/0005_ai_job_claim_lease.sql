ALTER TABLE ai_jobs
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
