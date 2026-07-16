-- 0054: Per-section content-change tracking (questionnaire answer reuse, #spec
-- 2026-07-16-questionnaire-mode). content_changed_at moves ONLY when a section's
-- (heading, content) pair actually changes — the same byte-identical condition
-- that decides embedding carry-forward in upsertSections — so it answers "is
-- anything relevant newer than this stored answer?" without doc-level noise.
-- Backfill to now() is deliberately conservative: content predating the column
-- briefly reads as "just changed", suppressing (never corrupting) reuse until
-- the first re-answer.
ALTER TABLE document_sections
  ADD COLUMN content_changed_at timestamptz NOT NULL DEFAULT now();
