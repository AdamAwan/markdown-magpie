-- Track hint credibility via agent consensus count (#219).
-- Each time an agent independently contributes the same topic → paths mapping,
-- increment the count. High-consensus hints are more trustworthy and can be
-- surfaced more prominently. Capped at a reasonable max (5) to keep the data model simple.
ALTER TABLE source_map_entries
  ADD COLUMN consensus_count INTEGER NOT NULL DEFAULT 1;
