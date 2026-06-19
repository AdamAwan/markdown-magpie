-- Run-lock for scheduled side-processes. A non-null running_since marks a run
-- in flight; both the scheduler and the manual "Run now" endpoint acquire it
-- atomically before running and clear it when done, so a slow run, a second
-- manual trigger, or another API instance can't start an overlapping run. A
-- stale lock (a crashed runner that never cleared it) is reclaimed after a
-- timeout so the task can't wedge permanently.
ALTER TABLE scheduled_task_settings ADD COLUMN IF NOT EXISTS running_since timestamptz;
