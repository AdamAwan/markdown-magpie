-- When an imported item's stage-2 (source-grounded) check was enqueued
-- (docs/superpowers/specs/2026-08-11-questionnaire-ingestion-design.md D5).
--
-- Escalation is bounded per tick and resumes on the next worksheet read, so the
-- sweep needs to know which items already have a stage-2 job in flight. The
-- obvious shortcut — overwriting import_verdict to take the item out of the
-- awaiting list — would make the worksheet report a verdict the adjudication
-- never reached. The verdict stays honest; this column tracks the sweep.
ALTER TABLE questionnaire_items ADD COLUMN import_escalated_at timestamptz;

-- Rebuild the escalation lookup to exclude already-escalated items. The 0063
-- index it replaces did not know about this column.
DROP INDEX IF EXISTS questionnaire_items_import_verdict_idx;
CREATE INDEX IF NOT EXISTS questionnaire_items_awaiting_escalation_idx
  ON questionnaire_items (questionnaire_id, import_verdict)
  WHERE imported_answer IS NOT NULL AND import_escalated_at IS NULL;
