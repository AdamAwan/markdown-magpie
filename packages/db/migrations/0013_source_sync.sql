-- Source-change sync: watch each flow's sources for new commits and rewrite the
-- knowledge-base documents whose facts the change has outdated, landing the
-- result on a review branch. State tracks the last commit reacted to per
-- flow/source; runs record each sync for the operator.

-- One row per (flow, source). The default flow is stored as '' (not NULL) so the
-- composite primary key dedupes the default-flow row.
CREATE TABLE IF NOT EXISTS source_sync_state (
  flow_id text NOT NULL DEFAULT '',
  source_id text NOT NULL,
  last_sha text NOT NULL,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, source_id)
);

CREATE TABLE IF NOT EXISTS source_sync_runs (
  id text PRIMARY KEY,
  flow_id text,
  destination_id text,
  source_id text NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  job_id text,
  plan jsonb,
  error text,
  from_sha text,
  to_sha text NOT NULL,
  changed_file_count integer NOT NULL DEFAULT 0,
  candidate_count integer NOT NULL DEFAULT 0,
  publication jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS source_sync_runs_created_at_idx ON source_sync_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS source_sync_runs_job_id_idx ON source_sync_runs (job_id);
