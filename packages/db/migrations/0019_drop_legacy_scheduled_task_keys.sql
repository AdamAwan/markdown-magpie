-- Scheduled tasks are now per-flow: every task key has the shape "<base>::<flow>"
-- (see apps/api/src/scheduling/task-registry.ts). Rows saved under the old
-- un-suffixed keys — "gaps-to-pull-requests", "source-change-sync", and the
-- long-removed "pull-request-refresh" — no longer match any registered task, so
-- they would never run and never surface in the UI. Drop them so the table only
-- holds live per-flow schedules.
--
-- Every key in the new scheme contains "::", so keying the delete on its absence
-- removes exactly the legacy rows and can never touch a current one.
DELETE FROM scheduled_task_settings WHERE task_key NOT LIKE '%::%';
