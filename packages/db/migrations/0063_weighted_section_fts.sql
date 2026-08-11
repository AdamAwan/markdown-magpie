-- Weighted full-text index for keyword retrieval (supersedes 0034).
--
-- 0034 indexed `heading || ' ' || content`, unweighted, so a section's ancestor
-- headings and its file path were unsearchable and a heading hit ranked no
-- higher than a body hit. This rebuilds the vector with four weighted fields:
--   A  heading             the section's own title
--   B  heading_path        ancestor headings ("Billing > Refunds")
--   B  path                the file path, punctuation flattened to spaces
--   C  content             body text
--
-- Maintained by a BEFORE trigger rather than GENERATED ALWAYS, because
-- array_to_string(anyarray, text) is STABLE, not IMMUTABLE, and a stored
-- generated column requires an IMMUTABLE expression. A trigger keeps 0034's
-- "no application-side maintenance" property without a hand-declared IMMUTABLE
-- wrapper (which would be an assertion we cannot enforce, and interacts badly
-- with dump/restore ordering).
--
-- A generated column's expression cannot be altered in place, so the column is
-- dropped and recreated. That rewrites document_sections; acceptable at current
-- corpus sizes, and the whole migration runs in one transaction.

DROP INDEX IF EXISTS document_sections_search_tsv_gin;
ALTER TABLE document_sections DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE document_sections ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION document_sections_search_tsv_refresh() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
       setweight(to_tsvector('english'::regconfig, coalesce(NEW.heading, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(array_to_string(NEW.heading_path, ' '), '')), 'B')
    -- Flatten path punctuation so "billing/annual-plans.md" tokenises into words.
    || setweight(to_tsvector('english'::regconfig, translate(coalesce(NEW.path, ''), '/-_.', '    ')), 'B')
    || setweight(to_tsvector('english'::regconfig, coalesce(NEW.content, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Scoped to the source columns on purpose: section rows are also updated to save
-- embeddings, and recomputing the tsvector on every embedding write would be
-- pure waste.
CREATE TRIGGER document_sections_search_tsv_trg
  BEFORE INSERT OR UPDATE OF heading, heading_path, path, content
  ON document_sections
  FOR EACH ROW EXECUTE FUNCTION document_sections_search_tsv_refresh();

-- Backfill. Touching `content` is what fires the trigger's UPDATE OF list;
-- assigning search_tsv directly would not.
UPDATE document_sections SET content = content;

CREATE INDEX document_sections_search_tsv_gin
  ON document_sections USING gin (search_tsv);
