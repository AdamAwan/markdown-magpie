-- Generic scheduled side-processes (e.g. pull request status refresh) managed
-- from the Crunch page. One row per task key from the server's task registry;
-- the cron is a standard 5-field expression evaluated in the server's local time.
CREATE TABLE IF NOT EXISTS scheduled_task_settings (
  task_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  cron text NOT NULL,
  last_run_at timestamptz,
  next_run_at timestamptz
);
