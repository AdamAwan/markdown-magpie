-- Index the two foreign keys that point at / out of document_sections and were
-- created without a supporting index (0001_initial.sql, 0008).
--
-- document_sections(document_id): every re-index replaces a document's sections
-- with `DELETE FROM document_sections WHERE document_id = ANY(...)`, the vector
-- and keyword searches join sections to documents on it, and the ON DELETE
-- CASCADE from documents has to find a deleted document's sections. Without an
-- index each of those is a sequential scan of the whole section table.
--
-- answer_citations(section_id): the ON DELETE CASCADE added in 0008 means every
-- deleted section looks up the citations that reference it. The primary key is
-- (question_id, section_id), which cannot serve a section_id-only lookup, so a
-- re-index that drops N sections did N sequential scans of answer_citations.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the migrator runs every file inside one
-- transaction (scripts/migrate.mjs), and CONCURRENTLY cannot run in a
-- transaction block. The build takes a SHARE lock on each table, which blocks
-- writes (re-indexing, answer citations) but not reads for its duration — on a
-- typical corpus that is seconds. See docs/ingestion.md IN30.
CREATE INDEX IF NOT EXISTS document_sections_document_id_idx
  ON document_sections (document_id);

CREATE INDEX IF NOT EXISTS answer_citations_section_id_idx
  ON answer_citations (section_id);
