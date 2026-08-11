-- Which retrieval mode was active when a gap was recorded.
--
-- In hybrid mode a search that returns nothing is strong evidence of absence:
-- vector search returns nearest neighbours for any query, so empty means nothing
-- close exists. In keyword-only mode it means only that no lexeme matched, which
-- is a far weaker claim. Gap candidacy (gapIdsForSummary) excludes keyword-mode
-- gaps so they never drive unattended proposal generation; they remain fully
-- visible in the console, because in a deployment that will never have an
-- embeddings endpoint, discarding them would switch the gaps subsystem off.
--
-- NULL means either "recorded before this column existed" or "not derived from
-- retrieval" (manual flags, feedback gaps). Both are treated as candidates,
-- preserving existing behaviour.
ALTER TABLE question_gaps
  ADD COLUMN IF NOT EXISTS retrieval_mode text
  CHECK (retrieval_mode IN ('hybrid', 'keyword'));
