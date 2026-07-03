-- Gap-closure verification. After a proposal merges and its destination
-- re-indexes, the triggering questions are re-asked and the answers checked
-- against the merged document. Resolution of a gap is now *evidence-based*:
-- the merge cascade no longer blindly marks gaps resolved — it records the
-- outcome of re-asking here and only resolves when a confident answer cites
-- the merged doc.

-- 1) Proposals: the verification outcome for this proposal's triggering gap.
-- Null until a verification has run. 'verified_closed' = every triggering
-- question is now answered by the merged doc; 'reopened' = at least one is
-- still weak (gaps left open to re-draft); 'needs_attention' = repeated
-- verification failures, flagged for a human instead of auto-redrafting.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS closure_status text;
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_closure_status_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_closure_status_check
  CHECK (closure_status IS NULL OR closure_status IN ('verified_closed', 'reopened', 'needs_attention'));

-- 2) Question gaps: carry the verification detail so a re-drafted proposal can
-- see *why* it is being resubmitted, and widen the source CHECK to admit the
-- two new machine sources. 'verification' = reopened after a failed closure
-- check; 'needs_attention' = reopened past the retry cap, awaiting a human.
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE question_gaps DROP CONSTRAINT IF EXISTS question_gaps_source_check;
ALTER TABLE question_gaps
  ADD CONSTRAINT question_gaps_source_check
  CHECK (source IN ('auto', 'manual', 'followup', 'verification', 'needs_attention'));

-- 3) Per-(proposal, triggering question) verification record. One row per
-- re-ask; the audit trail behind the closure_status above and the input to the
-- retry-cap loop guard (count of prior 'still_open' rows for a question).
CREATE TABLE IF NOT EXISTS gap_closure_verification (
  id text PRIMARY KEY,
  proposal_id text NOT NULL REFERENCES proposals(id),
  gap_cluster_id text,
  question_id text NOT NULL,
  reasked_question_id text,
  verdict text NOT NULL CHECK (verdict IN ('closed', 'still_open')),
  confidence text NOT NULL,
  cited_merged_doc boolean NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gap_closure_verification_question_idx
  ON gap_closure_verification (question_id, verdict);
CREATE INDEX IF NOT EXISTS gap_closure_verification_proposal_idx
  ON gap_closure_verification (proposal_id);
