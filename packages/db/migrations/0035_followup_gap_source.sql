-- Knowledge gaps can now be raised from a *confident* answer: when the model
-- runs a follow-up search for supporting material (e.g. a concrete example of X)
-- during the agentic answer loop and that search comes back empty, it records a
-- "followup" gap. These are qualitatively different from whole-question ("auto")
-- misses — they point at a specific missing artifact — so they get their own
-- source label and can be surfaced/filtered separately. Widen the CHECK to admit
-- it. Additive; existing rows keep their source.
ALTER TABLE question_gaps DROP CONSTRAINT IF EXISTS question_gaps_source_check;
ALTER TABLE question_gaps
  ADD CONSTRAINT question_gaps_source_check CHECK (source IN ('auto', 'manual', 'followup'));
