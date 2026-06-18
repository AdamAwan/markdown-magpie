-- Drop the dead gap_clusters table. Nothing ever wrote to it: clusters are
-- recomputed on demand and never persisted (see SuggestedGapCluster), so the
-- table, the proposals.gap_cluster_id FK column, and the reset-path delete were
-- all dead weight. Dropping the column also drops its FK constraint.

ALTER TABLE proposals DROP COLUMN IF EXISTS gap_cluster_id;

DROP TABLE IF EXISTS gap_clusters;
