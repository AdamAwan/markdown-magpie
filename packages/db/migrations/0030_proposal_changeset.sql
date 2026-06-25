-- A proposal's file-set, when it writes/deletes more than one document. Absent for
-- single-file proposals (gap/verify/source-sync), which keep using target_path +
-- markdown. dedupe (and later split) set it so the reconcile gate sees every path
-- the change touches and publication commits them all in one branch.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS changeset jsonb;
