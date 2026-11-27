-- Continuation state for non-blocking maintenance orchestrators.
--
-- A maintenance orchestrator (verify_gap_closure, process_gaps_to_pull_requests,
-- correctness_patrol) used to enqueue a follow-up AI job and then bounded-wait on
-- it inside the API while the claiming watcher blocked in the callback — so the
-- follow-up could only ever be run by a SECOND watcher. Orchestrators now enqueue
-- and return; the orchestration resumes from the follow-up job's completion
-- handler. That continuation needs to know which orchestration a completing job
-- belongs to and what it was in the middle of, which is what a row here records:
--
--   job_id       the follow-up AI job (answer_question re-ask, reconcile_gap_clusters
--                reshape, verify_document check)
--   orchestrator which orchestration owns it
--   scope_key    the unit the orchestration settles as a whole (proposal id, flow
--                key, patrol run id) — the continuation lists a scope to decide
--                whether everything it was waiting for has arrived
--   context      what the continuation needs that the job input does not carry
--   status       pending until the follow-up's outcome has been applied
--   result       the applied outcome, kept so a scope can be settled from rows
--                alone (never from a job row that retention may have deleted)
--
-- Kept off the job input schemas on purpose (like job_repair_contexts): this is
-- orchestration bookkeeping, not part of any job's domain contract, and several
-- of these inputs are rendered verbatim into prompts.
CREATE TABLE IF NOT EXISTS orchestration_followups (
  job_id text PRIMARY KEY,
  orchestrator text NOT NULL,
  scope_key text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX IF NOT EXISTS orchestration_followups_scope_idx
  ON orchestration_followups (orchestrator, scope_key, created_at);
