-- Fix-patrol: a rolling cursor over each flow's knowledge-base documents. The
-- cursor records when each document was last checked; runs record each tick for
-- the operator. (The correctness lenses that act on checked docs come later.)

-- One row per (flow, document). The default flow is stored as '' (not NULL) so the
-- composite primary key dedupes the default-flow row.
CREATE TABLE IF NOT EXISTS patrol_cursor (
  flow_id text NOT NULL DEFAULT '',
  doc_path text NOT NULL,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, doc_path)
);

CREATE TABLE IF NOT EXISTS patrol_runs (
  id uuid PRIMARY KEY,
  flow_id text,
  trigger text NOT NULL,
  universe_count integer NOT NULL DEFAULT 0,
  selected_count integer NOT NULL DEFAULT 0,
  selected jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS patrol_runs_created_at_idx ON patrol_runs (created_at DESC);
