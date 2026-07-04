-- Shared source-corpus snapshots (#163 Part 2). A patrol tick used to copy the
-- whole source corpus (~240KB) by value into every verify/correct/improve job in
-- the batch — persisted per job row and shipped to the watcher each time. Instead
-- the corpus is now stored ONCE per tick, content-addressed by its hash, and each
-- job carries only that hash; the watcher fetches the corpus by ref and caches it.
--
-- Content-addressed: the primary key is the corpus hash, so an unchanged corpus
-- across ticks reuses one row (the upsert just bumps last_used_at). Jobs are
-- short-lived, so snapshots are prunable once no in-flight job can reference them
-- (the store deletes rows untouched for longer than its retention window).
-- Additive and re-runnable.
CREATE TABLE IF NOT EXISTS source_corpus_snapshot (
  hash text PRIMARY KEY,
  corpus jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

-- Supports the retention prune (delete rows whose last_used_at fell out of the
-- window) without scanning the whole table.
CREATE INDEX IF NOT EXISTS source_corpus_snapshot_last_used_idx
  ON source_corpus_snapshot (last_used_at);
