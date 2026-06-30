-- SHA-based incremental indexing: record the commit each repository was last
-- indexed at, so a reindex can diff only the files that changed since then
-- instead of re-reading and re-parsing every markdown file in the source.
--
-- Nullable on purpose: existing repositories have no recorded SHA, and any
-- repository whose indexed SHA is null (or whose stored SHA is not an ancestor
-- of the current HEAD) falls back to a full reindex. Correctness never depends
-- on this column being populated — it is purely an optimization hint.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS indexed_commit_sha text;
