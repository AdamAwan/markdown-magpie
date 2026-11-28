-- Terminal-failure settlement ledger (docs/ai-jobs.md J63–J65).
--
-- A job that ends in `failed` has side effects that must run exactly once: fail
-- its linked source-sync run, mark its questionnaire item / import failed,
-- enqueue a fold fallback, write off a patrol verify or gap-closure re-ask. They
-- used to run only inside POST /api/jobs/:id/fail, so a job pg-boss failed by
-- itself (active-state expiry, a lost heartbeat, a crashed claimant exhausting
-- its retries) never ran them and its run/item/fold stalled forever.
--
-- Every terminal failure now settles through this ledger, from the fail route or
-- from the API's periodic sweep over pg-boss's failed rows, whichever gets there
-- first. A row is a claim while `settled_at` is NULL (one settler at a time,
-- across API replicas; a claim older than the lease is presumed crashed and can
-- be taken over) and a permanent "done" marker once `settled_at` is set.
CREATE TABLE IF NOT EXISTS job_failure_settlements (
  job_id uuid PRIMARY KEY,
  job_type text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

-- The sweep only considers failures at or after this instant. Without it, the
-- first sweep after upgrading would replay side effects for every failed job
-- still retained (30 days), including the ones the old fail route already
-- handled — e.g. enqueueing a second fold fallback.
CREATE TABLE IF NOT EXISTS job_failure_settlement_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  since timestamptz NOT NULL DEFAULT now()
);

INSERT INTO job_failure_settlement_epoch (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;
