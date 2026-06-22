CREATE UNIQUE INDEX IF NOT EXISTS proposals_job_id_unique
  ON proposals (job_id) WHERE job_id IS NOT NULL;
