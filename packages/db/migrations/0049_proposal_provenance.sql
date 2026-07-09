-- Per-claim source provenance captured from the draft job output (#214):
-- ProvenanceClaim[] — each substantive claim in the drafted markdown with the
-- source repo/path locations that ground it. Written once at proposal
-- creation, like draft_context (0020). On a MERGED proposal this row is the
-- append-only provenance EVENT for its target_path — documents themselves
-- carry no provenance (nothing to leak into answers). NULL: drafted before
-- this feature, or the draft omitted the field.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS provenance jsonb;
