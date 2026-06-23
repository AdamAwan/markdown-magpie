-- The latest review decision observed on a proposal's pull request, polled by the
-- watcher's refresh_pull_requests job. Nullable: proposals without an open PR (or
-- drafted before this migration) have no review decision. The reconcile gate reads
-- it to keep an approved PR non-touchable, so fold never rewrites an approved PR.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS review_decision text;
