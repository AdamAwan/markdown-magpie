-- Full-text search support for keyword retrieval.
-- Replaces the in-memory O(N) substring scan over every section with a Postgres
-- full-text search using a precomputed tsvector and a GIN index. The column is
-- GENERATED ALWAYS ... STORED so it backfills existing rows automatically and
-- stays in sync on every insert/update without application-side maintenance.
-- Queried via websearch_to_tsquery + ts_rank in PostgresKnowledgeStore.keywordSearch.
-- The expression must be IMMUTABLE for a STORED generated column. The two-arg
-- to_tsvector(regconfig, text) form is IMMUTABLE; pin the config explicitly with
-- ::regconfig so the column does not depend on default_text_search_config.
ALTER TABLE document_sections
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, coalesce(heading, '') || ' ' || coalesce(content, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS document_sections_search_tsv_gin
  ON document_sections USING gin (search_tsv);
