-- Source-change sync: persist the constrained changeset the API derives from the
-- generated plan at gather time (only writes to candidate documents). Storing the
-- final changeset — rather than the candidate paths — lets the later
-- publish_source_sync job fetch exactly what to write without re-running
-- retrieval/candidate selection.
--
-- NOTE: the queue-only migration plan once reserved 0014 for "remove custom AI
-- queue" (Task 12), but 0014 was taken by 0014_question_flow.sql long ago; Task 12
-- should take the next free number at its time.
ALTER TABLE source_sync_runs ADD COLUMN IF NOT EXISTS changeset jsonb;
