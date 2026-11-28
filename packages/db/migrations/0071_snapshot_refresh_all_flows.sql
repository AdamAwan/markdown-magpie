-- The snapshot-refresh (PR poll) task is no longer per-flow. Its job takes no
-- flow: one run polls every open pull request and rewrites every flow's
-- snapshot, so the per-flow "snapshot-refresh::<flow>" schedules only fired N
-- identical runs. It is now a single all-flows task keyed "snapshot-refresh::all"
-- (see apps/api/src/scheduling/task-registry.ts).
--
-- Carry the operator's intent over: if any per-flow row was enabled, enable the
-- single task with that row's cron (first by key when several were enabled).
-- Then drop the per-flow rows, which no longer match a registered task; the
-- schedule reconciler unschedules their pg-boss schedules at the next startup.
INSERT INTO scheduled_task_settings (task_key, enabled, cron)
SELECT 'snapshot-refresh::all', true, cron
FROM scheduled_task_settings
WHERE task_key LIKE 'snapshot-refresh::%'
  AND task_key <> 'snapshot-refresh::all'
  AND enabled
ORDER BY task_key
LIMIT 1
ON CONFLICT (task_key) DO UPDATE SET enabled = true, cron = EXCLUDED.cron;

DELETE FROM scheduled_task_settings
WHERE task_key LIKE 'snapshot-refresh::%'
  AND task_key <> 'snapshot-refresh::all';
