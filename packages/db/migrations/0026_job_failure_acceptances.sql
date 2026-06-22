CREATE TABLE IF NOT EXISTS job_failure_acceptances (
  job_id text PRIMARY KEY,
  accepted_at timestamptz NOT NULL DEFAULT now()
);