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
-- dropped and recreated.
--
-- OPERATIONAL COST — read before running this on a large corpus. scripts/migrate.mjs
-- wraps each migration file in a single transaction, so the DROP INDEX below takes
-- an ACCESS EXCLUSIVE lock on document_sections and HOLDS IT UNTIL COMMIT — that is,
-- across the DROP/ADD COLUMN, the full `UPDATE document_sections SET content = content`
-- backfill AND the CREATE INDEX at the end. Every read and every write of
-- document_sections blocks for that entire duration; this is not merely "a rewrite",
-- retrieval and indexing are down for the whole backfill+reindex. The backfill also
-- rewrites every row, roughly doubling the table's heap size, with no opportunity to
-- VACUUM inside the transaction.
--
-- Therefore: on a large corpus, run this in a maintenance window, and afterwards run
--   VACUUM (ANALYZE) document_sections;
-- to reclaim the dead tuples the backfill left behind and refresh planner statistics
-- for the new column and index.

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
