-- answer_citations is write-only audit data that mirrors questions.metadata; it
-- is never read back by the application. Its section_id FK (0001_initial.sql) was
-- created without ON DELETE CASCADE, unlike the sibling question_id FK, so any
-- delete of a document_section that a citation references fails with
-- answer_citations_section_id_fkey. That blocks both the admin reset and the
-- routine per-document re-index (DELETE FROM document_sections ...).
--
-- Recreate the constraint with ON DELETE CASCADE so sections can always be
-- replaced; orphaned audit rows are removed with their section.
ALTER TABLE answer_citations
  DROP CONSTRAINT IF EXISTS answer_citations_section_id_fkey;

ALTER TABLE answer_citations
  ADD CONSTRAINT answer_citations_section_id_fkey
  FOREIGN KEY (section_id) REFERENCES document_sections(id) ON DELETE CASCADE;
