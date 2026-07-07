-- Phase-1 gap assignment (embedding-based coarse pre-clustering) stores each
-- cluster's representative embedding: the L2-normalised centroid of its
-- distinct active member gap summaries. NULL means "recompute lazily on the
-- next assignment pass" — the state for pre-existing clusters and for any
-- cluster whose composition a reshape/prune just changed. Same type/dimension
-- as document_sections.embedding (0001). No ANN index: per-flow active cluster
-- counts are small and similarity is computed in the API against the loaded set.
ALTER TABLE gap_clusters
  ADD COLUMN IF NOT EXISTS representative_embedding vector(1536);
