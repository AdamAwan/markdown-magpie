-- A published proposal's PR can go stale: main advances and touches the same file,
-- so the branch no longer merges. Magpie auto-regenerates the doc against the fresh
-- base and force-pushes. This counter bounds that retry loop — once it reaches the
-- cap the proposal is surfaced for a human instead of regenerating forever.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS regeneration_count integer NOT NULL DEFAULT 0;
