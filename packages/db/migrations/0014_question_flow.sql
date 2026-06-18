-- Record which knowledge flow answered each question. The flow scopes retrieval
-- and supplies the persona at /ask time; persisting it here lets a knowledge gap
-- (derived from low-confidence/flagged questions) be attributed back to the flow
-- that produced it, so gaps cluster per flow and proposals draft to that flow's
-- destination. NULL for un-routed/legacy questions.
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS flow_id text;

CREATE INDEX IF NOT EXISTS questions_flow_idx ON questions (flow_id);
