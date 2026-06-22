-- Best-effort registry of connected watchers, powering the Jobs screen's
-- "connected workers" view. The API upserts a row on every claim/heartbeat the
-- watcher makes; busy/idle is derived from which call arrived. `name` is the
-- watcher's per-process unique id (`<WATCHER_NAME>-<uuid>`), so scaled replicas
-- never collide. There is no deregistration: stale rows are pruned on read once
-- they fall outside the active window. State only, never a source of truth for
-- job execution (pg-boss owns that).
CREATE TABLE IF NOT EXISTS watcher_registrations (
  name text PRIMARY KEY,
  status text NOT NULL,
  capabilities text[] NOT NULL DEFAULT '{}',
  current_job_id text,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
