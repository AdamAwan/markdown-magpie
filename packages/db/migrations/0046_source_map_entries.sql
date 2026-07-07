-- Source map (#215): persistent, agent-maintained navigation hints per source
-- repository. Source-grounded jobs read the most-recently-updated entries as
-- prompt hints and contribute updates back on completion. Internal metadata
-- only — never enters answer retrieval. One row per (source_id, topic);
-- observed_sha records the checkout HEAD a hint was observed at (nullable).
CREATE TABLE IF NOT EXISTS source_map_entries (
  id UUID PRIMARY KEY,
  source_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  paths JSONB NOT NULL,
  description TEXT NOT NULL,
  observed_sha TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT source_map_entries_source_topic_unique UNIQUE (source_id, topic)
);

CREATE INDEX IF NOT EXISTS source_map_entries_source_updated_idx
  ON source_map_entries (source_id, updated_at DESC);
