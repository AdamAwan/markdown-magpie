-- The asserted-claims register: things we have told customers that our own
-- sources do not support (ingesting completed questionnaires,
-- docs/superpowers/specs/2026-08-11-questionnaire-ingestion-design.md D6).
--
-- Two kinds down one pipe, mirroring how verify_document returns two finding
-- kinds:
--   'unsubstantiated' — no source anywhere asserts it (the phantom certificate)
--   'contradicted'    — the sources say something materially different
-- Both resolve identically: a human points at a source, corrects the record, or
-- dismisses. Magpie never adjudicates and never edits a source repository to
-- make a claim true — the same posture source_conflicts takes.
--
-- One row per fingerprint, so re-ingesting the same questionnaire re-detects
-- rather than duplicates. Detection upserts on fingerprint and NEVER changes
-- status, which is what keeps a dismissal sticky. flow_id is folded into the
-- fingerprint by the caller as a sentinel string rather than left NULL, because
-- Postgres treats NULLs as distinct in a unique index and dedupe on the unscoped
-- flow would silently fail.
--
-- The questionnaire/item references are ON DELETE SET NULL, not CASCADE: a
-- finding about an unbackable claim outlives the worksheet that surfaced it.
-- Deleting the questionnaire must not quietly erase the compliance record.
CREATE TABLE IF NOT EXISTS asserted_claims (
  id UUID PRIMARY KEY,
  flow_id TEXT,
  questionnaire_id TEXT REFERENCES questionnaires(id) ON DELETE SET NULL,
  item_id TEXT REFERENCES questionnaire_items(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  claim TEXT NOT NULL,
  -- AssertedClaimPosition[]: for 'contradicted', what each source location
  -- actually says. Empty for 'unsubstantiated' — that absence IS the finding.
  positions JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  fingerprint TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count INTEGER NOT NULL DEFAULT 1,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  CONSTRAINT asserted_claims_fingerprint_unique UNIQUE (fingerprint),
  CONSTRAINT asserted_claims_kind_check CHECK (kind IN ('unsubstantiated', 'contradicted')),
  CONSTRAINT asserted_claims_status_check CHECK (status IN ('open', 'resolved', 'dismissed'))
);

-- The register listing (status + flow filters, newest activity first).
CREATE INDEX IF NOT EXISTS asserted_claims_status_flow_idx
  ON asserted_claims (status, flow_id, last_seen_at DESC);

-- The approval gate asks "does this item have an open finding?" on every
-- approve of imported wording, so that lookup gets its own partial index.
CREATE INDEX IF NOT EXISTS asserted_claims_open_item_idx
  ON asserted_claims (item_id)
  WHERE status = 'open';
