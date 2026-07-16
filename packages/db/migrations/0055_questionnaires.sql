-- 0055: Questionnaire mode (spec 2026-07-16-questionnaire-mode). A questionnaire
-- is a named batch of questions pinned to a flow; items reuse prior approved
-- answers verbatim when the KB says they're still valid (see the reuse check in
-- apps/api/src/features/questionnaires/). The item history IS the canonical
-- answer store — citations are snapshotted at approval into
-- questionnaire_item_citations because answer_citations rows cascade-delete
-- when a re-index removes a section id.

-- Questionnaire asks get their own purpose: kept IN gap candidacy (an
-- unanswerable questionnaire question is a real gap — the flywheel), kept OUT
-- of the live questions list (the worksheet is their surface).
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_purpose_check;
ALTER TABLE questions ADD CONSTRAINT questions_purpose_check
  CHECK (purpose IN ('live', 'verification', 'questionnaire'));

CREATE TABLE questionnaires (
  id text PRIMARY KEY,
  name text NOT NULL,
  flow_id text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE questionnaire_items (
  id text PRIMARY KEY,
  questionnaire_id text NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE,
  position integer NOT NULL,
  question text NOT NULL,
  -- Embedded at creation (or backfilled at approval) for near-verbatim matching
  -- against future questionnaires; stamped with the model per 0052's convention.
  question_embedding vector(1536),
  embedding_model text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'answering', 'answered', 'unanswerable', 'approved')),
  outcome text CHECK (outcome IN ('reused', 'fresh', 'changed')),
  answer text,
  -- For reused items this is the ORIGINAL generation time carried forward —
  -- the freshness baseline for future newcomer checks (see spec).
  answered_at timestamptz,
  question_log_id text,
  reused_from_item_id text REFERENCES questionnaire_items(id),
  change_reason jsonb,
  error text,
  approved_at timestamptz,
  -- Set when a cited section was already gone at approval time: the item is
  -- approved for export but can never pass reuse check 1, by construction.
  stale_at_approval boolean NOT NULL DEFAULT false,
  UNIQUE (questionnaire_id, position)
);

CREATE INDEX questionnaire_items_questionnaire_idx
  ON questionnaire_items (questionnaire_id, status);
CREATE INDEX questionnaire_items_question_log_idx
  ON questionnaire_items (question_log_id) WHERE question_log_id IS NOT NULL;

-- Durable citation fingerprints, snapshotted at approval. Deliberately NOT a
-- FK to document_sections: the fingerprint must survive the section's deletion.
CREATE TABLE questionnaire_item_citations (
  item_id text NOT NULL REFERENCES questionnaire_items(id) ON DELETE CASCADE,
  section_id text NOT NULL,
  content_hash text NOT NULL,
  path text NOT NULL,
  heading text NOT NULL,
  excerpt text NOT NULL,
  PRIMARY KEY (item_id, section_id)
);
