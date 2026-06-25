-- A proposal's flow, independent of its gap cluster. Gap proposals leave this null
-- and resolve their flow via the cluster (unchanged); patrol-lens proposals
-- (verify, and later dedupe/split/complete) set it directly so the reconcile gate
-- sees them as same-flow and the per-flow publication outbox drains them.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS flow_id text;
