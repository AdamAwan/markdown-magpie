CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE repositories (
  id text PRIMARY KEY,
  name text NOT NULL,
  remote_url text,
  default_branch text NOT NULL,
  local_path text NOT NULL,
  provider text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id text PRIMARY KEY,
  repository_id text NOT NULL REFERENCES repositories(id),
  path text NOT NULL,
  commit_sha text,
  title text NOT NULL,
  owner text,
  status text NOT NULL DEFAULT 'active',
  last_verified date,
  review_cycle_days integer,
  content text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, path)
);

CREATE TABLE document_sections (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  path text NOT NULL,
  heading text NOT NULL,
  heading_path text[] NOT NULL,
  anchor text NOT NULL,
  ordinal integer NOT NULL,
  content text NOT NULL,
  embedding vector(1536)
);

CREATE TABLE questions (
  id text PRIMARY KEY,
  question text NOT NULL,
  confidence text NOT NULL DEFAULT 'unknown',
  answer text,
  asked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE answer_citations (
  question_id text NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  section_id text NOT NULL REFERENCES document_sections(id),
  excerpt text NOT NULL,
  PRIMARY KEY (question_id, section_id)
);

CREATE TABLE gap_clusters (
  id text PRIMARY KEY,
  summary text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE proposals (
  id text PRIMARY KEY,
  gap_cluster_id text REFERENCES gap_clusters(id),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  target_path text NOT NULL,
  markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_jobs (
  id text PRIMARY KEY,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  input jsonb NOT NULL,
  output jsonb,
  error text,
  claimed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_jobs_status_type_idx ON ai_jobs (status, type, created_at);
