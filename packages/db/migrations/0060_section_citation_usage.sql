-- 0060: Durable per-section citation usage (spec 2026-07-25-citation-usage-tracking).
-- Records how often each knowledge section is cited by an answer, so a future
-- trim of the knowledge base has evidence for what is and is not earning its keep.
--
-- Why not just aggregate answer_citations? That table is write-only audit data
-- keyed on section_id (= "<documentId>:<ordinal>"), which a re-index renumbers,
-- and it fails in BOTH directions:
--   - Rows vanish. The section_id FK cascades (0008_citation_section_cascade.sql),
--     so deleting a document — or shrinking one past a cited ordinal — takes its
--     citation history with it. The question scrub cascades them too.
--   - Rows silently re-point. Insert a section above a cited one and the ordinals
--     shift beneath the surviving rows: the citation now claims a DIFFERENT
--     heading, and an aggregate would credit the usage to the wrong section.
-- Either way a knowledge base that gets edited cannot answer "what is being used?"
-- from its own audit trail.
--
-- The key is therefore (document_id, anchor) — the same durable section identity
-- the claim-provenance fold re-anchors against — and there are deliberately NO
-- foreign keys, for the same reason questionnaire_item_citations has none: the
-- record must outlive the section (and document) row it describes. A usage row
-- whose section is no longer indexed is evidence that something used got deleted,
-- and the report says exactly that.
--
-- path/heading are the latest observed display labels, refreshed on each
-- increment, so a row stays readable once its section leaves the index.
CREATE TABLE IF NOT EXISTS section_citation_usage (
  document_id text NOT NULL,
  anchor text NOT NULL,
  path text NOT NULL,
  heading text NOT NULL,
  citation_count integer NOT NULL DEFAULT 0,
  first_cited_at timestamptz NOT NULL DEFAULT now(),
  last_cited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, anchor)
);

-- The report's default ordering is "least used, oldest first"; this index also
-- serves the document rollup's prefix scan on document_id (leading PK column).
CREATE INDEX IF NOT EXISTS section_citation_usage_count_idx
  ON section_citation_usage (citation_count, last_cited_at);
