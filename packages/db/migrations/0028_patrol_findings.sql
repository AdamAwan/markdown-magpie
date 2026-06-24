-- Verify-lens findings recorded on each fix-patrol run (path + unprovable claims +
-- the reconcile gate's decision). Defaults to an empty array so existing rows and
-- lens-less runs are valid.
ALTER TABLE patrol_runs
  ADD COLUMN findings jsonb NOT NULL DEFAULT '[]'::jsonb;
