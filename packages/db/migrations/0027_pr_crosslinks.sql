-- Records that two open pull requests in a flow were detected to overlap on the
-- same knowledge-base file and cross-linked once, so the reconciler does not
-- re-comment them every tick. The pair is normalised (low/high) so (a,b)==(b,a).
CREATE TABLE IF NOT EXISTS pr_crosslinks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_id text,
  proposal_low text NOT NULL,
  proposal_high text NOT NULL,
  targets text[] NOT NULL DEFAULT '{}',
  linked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_low, proposal_high)
);
