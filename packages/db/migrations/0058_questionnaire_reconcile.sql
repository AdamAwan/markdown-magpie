-- 0058: Reconciliation reuse. Widen the item outcome to include model verdicts
-- 'adapted' and 'merged'; record multi-source provenance in a basis table; and
-- stash the top-N candidate ids chosen at match time so the answer drip can
-- prime the answer_question job. See 2026-07-17-questionnaire-trust-design.md.
ALTER TABLE questionnaire_items DROP CONSTRAINT IF EXISTS questionnaire_items_outcome_check;
ALTER TABLE questionnaire_items ADD CONSTRAINT questionnaire_items_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('reused', 'fresh', 'changed', 'adapted', 'merged'));

ALTER TABLE questionnaire_items
  ADD COLUMN IF NOT EXISTS reconcile_candidate_ids jsonb;

-- Durable provenance for adapted/merged (and single-source reused). Deliberately
-- NOT a FK to questionnaire_items so it survives a basis item's deletion.
CREATE TABLE IF NOT EXISTS questionnaire_item_basis (
  item_id text NOT NULL REFERENCES questionnaire_items(id) ON DELETE CASCADE,
  basis_item_id text NOT NULL,
  PRIMARY KEY (item_id, basis_item_id)
);
