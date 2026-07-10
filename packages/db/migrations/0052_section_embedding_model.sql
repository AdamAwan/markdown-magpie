-- Records which embedding model produced each section vector (#242). Vectors
-- from different models (or dimensions) are not comparable, so query-time
-- vector search must only match sections embedded by the currently configured
-- model, and a model change must re-embed rather than silently mix vectors.
-- NULL means "unknown" — either the section has no embedding yet, or the
-- vector predates this column; the API adopts such legacy vectors under the
-- configured model at startup (they can only have been produced by it).
ALTER TABLE document_sections
  ADD COLUMN IF NOT EXISTS embedding_model text;
