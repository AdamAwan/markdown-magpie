-- The content-addressed source-corpus snapshot store (#163 Part 2) is dead: the
-- patrol jobs now carry source descriptors and the executing agent explores the
-- source checkouts directly (source-agentic grounding, increment 3), so nothing
-- writes or reads source_corpus_snapshot any more. Forward-only cleanup; safe to
-- re-run.
DROP INDEX IF EXISTS source_corpus_snapshot_last_used_idx;
DROP TABLE IF EXISTS source_corpus_snapshot;
