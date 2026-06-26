-- Generic maintenance-run audit: one durable record per scheduled-task execution
-- (patrols, gaps->PR, and later source-sync). Replaces the bespoke patrol_runs
-- table; source_sync_runs migrates later with Scope B. Dropping patrol_runs data
-- is acceptable (no production data yet).

CREATE TABLE IF NOT EXISTS maintenance_runs (
  id text PRIMARY KEY,
  task_type text NOT NULL,
  flow_id text,
  trigger text NOT NULL,
  status text NOT NULL,
  summary text NOT NULL DEFAULT '',
  error text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS maintenance_runs_task_started_idx ON maintenance_runs (task_type, started_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_runs_flow_started_idx ON maintenance_runs (flow_id, started_at DESC);

DROP TABLE IF EXISTS patrol_runs;
