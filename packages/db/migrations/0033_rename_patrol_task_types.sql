-- The patrol job types were renamed for clarity:
--   fix_patrol     -> correctness_patrol  (verify · dedupe · split)
--   improve_patrol -> editorial_patrol    (expand thin docs)
-- The job-type strings are also the pg-boss queue names and the MaintenanceRun
-- task_type, so historical audit rows still carry the old values. Forward-migrate
-- them to the new names so the Activity view groups and labels past runs correctly.
--
-- The third rename (refresh_pull_requests -> refresh_flow_snapshot) is a github
-- job, never a maintenance-run task_type, so it needs no data migration; its old
-- pg-boss schedule is torn down automatically by reconcileSchedules at startup.
UPDATE maintenance_runs SET task_type = 'correctness_patrol' WHERE task_type = 'fix_patrol';
UPDATE maintenance_runs SET task_type = 'editorial_patrol' WHERE task_type = 'improve_patrol';
