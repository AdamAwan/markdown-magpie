-- Persistent gap clusters and their proposal lineage. The dead gap_clusters table
-- and proposals.gap_cluster_id (never written) were dropped in 0015; this builds
-- the model the reconciler actually populates. GET /api/gaps/clusters reads from
-- here instead of clustering on demand.

CREATE TABLE IF NOT EXISTS gap_clusters (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_id text,
  title text NOT NULL,
  rationale text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  parent_cluster_id bigint REFERENCES gap_clusters(id) ON DELETE SET NULL,
  reconciliation_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gap_clusters_active_idx ON gap_clusters (flow_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS gap_cluster_memberships (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster_id bigint NOT NULL REFERENCES gap_clusters(id) ON DELETE CASCADE,
  gap_id bigint NOT NULL REFERENCES question_gaps(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  rationale text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One active membership per gap.
CREATE UNIQUE INDEX IF NOT EXISTS gap_cluster_memberships_one_active_idx
  ON gap_cluster_memberships (gap_id) WHERE active;
CREATE INDEX IF NOT EXISTS gap_cluster_memberships_cluster_idx
  ON gap_cluster_memberships (cluster_id) WHERE active;

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS gap_cluster_id bigint REFERENCES gap_clusters(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS proposals_gap_cluster_id_idx
  ON proposals (gap_cluster_id) WHERE gap_cluster_id IS NOT NULL;

-- Monotonic catalog revision, bumped in the same transaction as any change to the
-- unresolved candidate gaps. Single-row table.
CREATE TABLE IF NOT EXISTS gap_catalog (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO gap_catalog (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Reconciler bookkeeping: last catalog revision whose clustering is committed.
CREATE TABLE IF NOT EXISTS gap_reconciler_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  processed_revision bigint NOT NULL DEFAULT 0,
  last_run_at timestamptz
);
INSERT INTO gap_reconciler_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Idempotent publication outbox so crashes between DB commit, Git push, and the
-- GitHub update can be retried without repeating any model work.
CREATE TABLE IF NOT EXISTS gap_publication_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id text NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('publish', 'supersede')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gap_publication_actions_pending_idx
  ON gap_publication_actions (created_at) WHERE status = 'pending';
