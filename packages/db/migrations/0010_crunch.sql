-- Crunch: scheduled knowledge-base tidying (consolidate/split) with a
-- multi-file change plan that publishes to a review branch.

CREATE TABLE IF NOT EXISTS crunch_runs (
  id text PRIMARY KEY,
  flow_id text,
  destination_id text,
  trigger text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  job_id text,
  plan jsonb,
  error text,
  document_count integer NOT NULL DEFAULT 0,
  publication jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS crunch_runs_created_at_idx ON crunch_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS crunch_runs_job_id_idx ON crunch_runs (job_id);

-- One settings row per knowledge flow. The default flow is stored as '' (not
-- NULL) so ON CONFLICT (flow_id) upserts a single default-flow row.
CREATE TABLE IF NOT EXISTS crunch_settings (
  flow_id text PRIMARY KEY DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  -- Standard 5-field cron expression, evaluated in the API server's local time.
  cron text NOT NULL DEFAULT '0 2 * * *',
  last_run_at timestamptz,
  next_run_at timestamptz
);
