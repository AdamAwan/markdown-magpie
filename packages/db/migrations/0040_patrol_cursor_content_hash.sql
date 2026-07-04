-- Patrol change-gate (#163): record, per patrol cursor entry, a hash of the
-- document content and of the flow's source corpus at the time the doc was last
-- checked. A later tick can then skip re-verifying a byte-identical document
-- against a byte-identical source corpus — so an idle knowledge base costs ~zero
-- provider/embedding calls per tick instead of re-checking every doc hourly forever.
--
-- Nullable + no backfill: existing rows read as "hash unknown", which forces one
-- fresh check that records the hash, after which the gate engages. Additive and
-- re-runnable.
ALTER TABLE patrol_cursor ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE patrol_cursor ADD COLUMN IF NOT EXISTS sources_hash text;
