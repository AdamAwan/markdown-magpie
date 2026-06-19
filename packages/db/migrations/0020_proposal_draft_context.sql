-- Keep the context a proposal was drafted from (gaps, source files, evidence
-- count, and the flow's in-flight PRs the model was shown) alongside the
-- proposal, so a reviewer can see what the draft was based on — not just its
-- output. Nullable: proposals drafted before this migration have no record.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS draft_context jsonb;
