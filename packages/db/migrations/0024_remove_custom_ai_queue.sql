-- Remove the legacy custom AI job queue and the obsolete scheduler/execution
-- columns. pg-boss (the JobBroker) fully owns job persistence, run timing, and
-- overlap protection now, so the ai_jobs table and the run-bookkeeping columns
-- on crunch_settings / scheduled_task_settings are dead. The questions table's
-- execution_mode column is unused (no mock execution remains) and chat_provider
-- is always supplied explicitly, so its DEFAULT is dropped.
-- Everything is IF EXISTS-guarded so the migration is idempotent.

DROP TABLE IF EXISTS ai_jobs;

ALTER TABLE crunch_settings DROP COLUMN IF EXISTS last_run_at;
ALTER TABLE crunch_settings DROP COLUMN IF EXISTS next_run_at;

ALTER TABLE scheduled_task_settings DROP COLUMN IF EXISTS last_run_at;
ALTER TABLE scheduled_task_settings DROP COLUMN IF EXISTS next_run_at;
ALTER TABLE scheduled_task_settings DROP COLUMN IF EXISTS running_since;

ALTER TABLE questions DROP COLUMN IF EXISTS execution_mode;
ALTER TABLE questions ALTER COLUMN chat_provider DROP DEFAULT;
