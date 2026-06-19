-- A queryable record of the clustering decisions the gap reconciler makes —
-- proposed merges/splits, the model's rationale, the critic's verdict, and
-- whether the change was applied. These previously existed only as console logs,
-- so there was no way to see WHY a flow's clusters reshaped.
CREATE TABLE IF NOT EXISTS reconciliation_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_id text,
  kind text NOT NULL CHECK (kind IN ('merge', 'split')),
  rationale text NOT NULL,
  confirmed boolean NOT NULL,
  applied boolean NOT NULL,
  cluster_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reconciliation_decisions_created_at_idx
  ON reconciliation_decisions (created_at DESC);
