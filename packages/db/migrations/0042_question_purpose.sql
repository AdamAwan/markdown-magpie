-- Verification re-asks (verifyGapClosure) record ordinary question logs. Without
-- a marker they re-enter gap candidacy, the questions list, and gap clustering
-- under a fresh question id — auto-redrafting the very gap that was just parked
-- (issue #154). Tag them so those three consumers can exclude them.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'live'
  CHECK (purpose IN ('live', 'verification'));

-- Backfill history: any log referenced as a re-ask in the verification audit
-- trail is synthetic, regardless of when it was created.
UPDATE questions SET purpose = 'verification'
  WHERE id IN (
    SELECT reasked_question_id FROM gap_closure_verification
    WHERE reasked_question_id IS NOT NULL
  );
