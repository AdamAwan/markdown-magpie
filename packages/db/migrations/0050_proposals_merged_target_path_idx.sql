-- Phase-2 claim provenance (#214): verify reads a document's provenance
-- event stream = merged proposals for that path. Partial index keeps the
-- lookup cheap; changeset matches are rarer and filtered in the query.
CREATE INDEX IF NOT EXISTS proposals_merged_target_path_idx
  ON proposals (target_path, merged_at)
  WHERE status = 'merged';
