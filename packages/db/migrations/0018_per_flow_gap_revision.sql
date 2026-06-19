-- Per-flow gap catalog + reconciler state. Previously both were single-row tables
-- (id boolean = true): a gap change in ANY flow bumped one global counter, which
-- forced every flow's reconciler to re-cluster even when its own gaps were
-- unchanged. Keying both tables by flow_id scopes the revision gate to the flow
-- that actually changed. flow_id '' is the un-routed/default flow, matching the
-- coalesce(flow_id,'') convention used across the other gap tables.
--
-- The existing single row is preserved as the default-flow ('') row so the gate
-- does not spuriously re-run every flow once immediately after the migration.

ALTER TABLE gap_catalog ADD COLUMN IF NOT EXISTS flow_id text NOT NULL DEFAULT '';
ALTER TABLE gap_catalog DROP CONSTRAINT IF EXISTS gap_catalog_pkey;
ALTER TABLE gap_catalog DROP COLUMN IF EXISTS id;
ALTER TABLE gap_catalog ADD PRIMARY KEY (flow_id);

ALTER TABLE gap_reconciler_state ADD COLUMN IF NOT EXISTS flow_id text NOT NULL DEFAULT '';
ALTER TABLE gap_reconciler_state DROP CONSTRAINT IF EXISTS gap_reconciler_state_pkey;
ALTER TABLE gap_reconciler_state DROP COLUMN IF EXISTS id;
ALTER TABLE gap_reconciler_state ADD PRIMARY KEY (flow_id);
