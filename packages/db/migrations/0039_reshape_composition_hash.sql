-- Composition-hash short-circuit for the gap reconciler's reshape (issue #168).
-- The reconciler re-ran the metered propose→critic reshape on EVERY gap-catalog
-- revision bump, re-judging a compositionally-identical active cluster set to
-- re-conclude "no merges/splits/dismissals". Record the hash of the active cluster
-- composition (sorted cluster ids + each cluster's sorted membership gap ids) that
-- was last sent to the critic for this flow, so a later tick whose composition
-- hashes to the same value skips the reshape. NULL = never reshaped for this flow
-- (so the first reshape always runs). Lives alongside the per-flow processed
-- revision it complements.
ALTER TABLE gap_reconciler_state
  ADD COLUMN IF NOT EXISTS last_reshape_composition_hash text;
