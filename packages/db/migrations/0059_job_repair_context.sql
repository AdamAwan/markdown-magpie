-- Out-of-band repair context for the schema-invalid-output repair-reprompt path
-- (#288d). A repairable provider job whose watcher output fails its JSON contract
-- gets ONE informed repair: the prior output + the exact contract violations are
-- stashed here keyed by the job id, and the SAME job is re-dispatched (pg-boss
-- active -> retry) so every waiter and the question-log linkage still resolve
-- under the original id. The presence of a row IS the "one repair" counter —
-- repair is offered only when no row exists, and the row is deleted on success
-- and on terminal failure. Not stored on the job inputSchema on purpose: it must
-- never enter the domain contract or the enqueue/validation path.
CREATE TABLE IF NOT EXISTS job_repair_contexts (
  job_id text PRIMARY KEY,
  target_type text NOT NULL,
  prior_output jsonb NOT NULL,
  issues jsonb NOT NULL,
  attempt int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
