-- When a proposal is merged, the gaps it closed should stop surfacing as
-- candidates without being deleted, so we keep an audit trail of what was
-- resolved and by which proposal. Resolution is a soft flag on the gap row.
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS resolved_by_proposal_id uuid;

-- Most gap-candidate queries only care about unresolved gaps; index for that.
CREATE INDEX IF NOT EXISTS question_gaps_unresolved_idx
  ON question_gaps (question_id)
  WHERE resolved_at IS NULL;

-- Records when a proposal was marked merged. Marking merged is what resolves its
-- gaps and triggers a re-index of the destination knowledge base.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS merged_at timestamptz;
