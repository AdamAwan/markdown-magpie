-- Staging for an uploaded questionnaire file (docs/questionnaires.md Q29+).
-- The uploaded BYTES are never stored anywhere: `sheets` holds only the
-- extracted cell grid, and it is nulled on confirm, leaving filename + mapping
-- as the audit trail. Unconfirmed rows are swept after 24 hours.
CREATE TABLE IF NOT EXISTS questionnaire_imports (
  id text PRIMARY KEY,
  flow_id text NOT NULL,
  name text NOT NULL,
  filename text NOT NULL,
  format text NOT NULL,
  status text NOT NULL DEFAULT 'mapping',
  sheets jsonb,
  mapping jsonb,
  error text,
  questionnaire_id text,
  job_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS questionnaire_imports_created_idx ON questionnaire_imports (created_at);
CREATE INDEX IF NOT EXISTS questionnaire_imports_job_idx ON questionnaire_imports (job_id);
