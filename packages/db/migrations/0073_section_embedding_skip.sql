-- Records a section the background embedder gave up on, so one poison section
-- no longer blocks every section queued behind it (docs/ingestion.md IN31).
--
-- The embedder pages pending sections in id order. When the provider rejects a
-- section's text outright (and it still fails after truncation to the input
-- cap), that section used to come back at the head of every page and fail the
-- whole batch forever. The embedder now isolates the offender, embeds the rest,
-- and stamps the offender here. A skip is scoped to the model that rejected it
-- (embedding_skipped_model) and to the text it rejected: re-indexing a changed
-- heading/content clears all three columns (PostgresKnowledgeStore.upsertSections),
-- and a model change makes the old skip inapplicable, so either retries it.
--
-- Additive, nullable columns: existing rows read as "never skipped".
ALTER TABLE document_sections
  ADD COLUMN IF NOT EXISTS embedding_skipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS embedding_skipped_model text,
  ADD COLUMN IF NOT EXISTS embedding_skip_reason text;
