-- Ingesting completed questionnaires
-- (docs/superpowers/specs/2026-08-11-questionnaire-ingestion-design.md).
-- An imported questionnaire is an ordinary questionnaire whose items arrive with
-- a previously-given answer attached. That answer is UNTRUSTED EVIDENCE, never an
-- answer: Magpie still answers every question itself and the import is adjudicated
-- against it. import_origin's presence on the parent row is what switches on the
-- triage path, so a questionnaire created the ordinary way behaves exactly as it
-- did before this column existed.
ALTER TABLE questionnaires ADD COLUMN import_origin text;

ALTER TABLE questionnaire_items ADD COLUMN imported_answer text;
ALTER TABLE questionnaire_items ADD COLUMN import_verdict text
  CHECK (import_verdict IN ('confirmed', 'divergent', 'uncovered'));

-- The escalation sweep asks "which items of this questionnaire still need a
-- stage-2 check?" on every drip tick, so that lookup gets its own partial index.
CREATE INDEX IF NOT EXISTS questionnaire_items_import_verdict_idx
  ON questionnaire_items (questionnaire_id, import_verdict)
  WHERE imported_answer IS NOT NULL;
