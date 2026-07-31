-- Source conflicts: disagreements between the SOURCES themselves, found while
-- the correctness patrol fact-checks a knowledge-base document. Deliberately not
-- a proposal or a gap: Magpie cannot choose which source is right, so a conflict
-- is recorded, the document is annotated, and it stays open until humans fix the
-- disagreement at the source. Resolution is observed (the verify agent reports
-- the sources now agree), never adjudicated.
--
-- One row per fingerprint. The patrol re-verifies documents on a rolling cursor,
-- so the same conflict is re-detected repeatedly; detection upserts on
-- fingerprint (bumping seen_count/last_seen_at) and NEVER changes status, which
-- is what keeps a dismissal sticky. flow_id is folded into the fingerprint as a
-- sentinel string rather than left NULL, because Postgres treats NULLs as
-- distinct in a unique index and dedupe on the unscoped flow would silently fail.
CREATE TABLE IF NOT EXISTS source_conflicts (
  id UUID PRIMARY KEY,
  flow_id TEXT,
  document_path TEXT NOT NULL,
  anchor TEXT NOT NULL,
  topic TEXT NOT NULL,
  summary TEXT NOT NULL,
  claim TEXT NOT NULL,
  -- SourceConflictPosition[]: at least two sides, each with the source id, the
  -- repo-relative path the agent actually read, and what that location says.
  positions JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  fingerprint TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count INTEGER NOT NULL DEFAULT 1,
  annotated_proposal_id UUID,
  resolved_at TIMESTAMPTZ,
  agreed_statement TEXT,
  dismissal_note TEXT,
  CONSTRAINT source_conflicts_fingerprint_unique UNIQUE (fingerprint),
  CONSTRAINT source_conflicts_status_check CHECK (status IN ('open', 'resolved', 'dismissed'))
);

-- The register listing (status + flow filters, newest activity first).
CREATE INDEX IF NOT EXISTS source_conflicts_status_flow_idx
  ON source_conflicts (status, flow_id, last_seen_at DESC);

-- The patrol's change-gate exemption asks "which documents have an open
-- conflict?" on every tick, so that lookup gets its own index.
CREATE INDEX IF NOT EXISTS source_conflicts_open_document_idx
  ON source_conflicts (flow_id, document_path)
  WHERE status = 'open';
