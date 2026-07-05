-- "Parked, awaiting a human" (repeated gap-closure verification failures past the
-- retry cap) was encoded as source='needs_attention'. Model it as first-class
-- state alongside resolved_at / dismissed_at instead, so the "is parked" predicate
-- lives in one place and the scattered source special-cases collapse (issue #158).
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS parked_at timestamptz;
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS parked_reason text;

-- Backfill existing escalations, then fold the pseudo-source back into 'verification'
-- (both were the same server-raised source at two escalation levels). parked_at =
-- created_at is the first-failure time (rows are updated in place across reopens),
-- not the exact park time — cosmetic, not load-bearing.
UPDATE question_gaps SET parked_at = created_at, parked_reason = 'verification retry cap'
  WHERE source = 'needs_attention';
UPDATE question_gaps SET source = 'verification' WHERE source = 'needs_attention';

-- Narrow the source CHECK now that no needs_attention rows remain (drop-add pattern
-- mirrors 0035/0038). Backfill above guarantees no row violates the narrowed check.
ALTER TABLE question_gaps DROP CONSTRAINT IF EXISTS question_gaps_source_check;
ALTER TABLE question_gaps ADD CONSTRAINT question_gaps_source_check
  CHECK (source IN ('auto', 'manual', 'followup', 'verification'));

-- Anti-join index for the question-level park exclusion used by candidacy and
-- clustering: a live parked row (unresolved, undismissed) excludes the whole question.
CREATE INDEX IF NOT EXISTS question_gaps_parked_idx ON question_gaps (question_id)
  WHERE parked_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL;
