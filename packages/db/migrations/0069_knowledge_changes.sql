-- 0069: Durable knowledge change log (spec 2026-08-27-knowledge-change-log).
-- An append-only record of what actually changed in the destination knowledge
-- base, when, and what caused it. Written by the index-time diff — the one choke
-- point every corpus change passes through — so a hand edit or an out-of-band
-- merge is logged just as a Magpie proposal is, and an entry always describes a
-- change that TOOK EFFECT rather than one that was merely proposed.
--
-- Why not read document_sections.content_changed_at (0054) instead? Because
-- upsertSections keys on section_id = "<documentId>:<ordinal>" and compares the
-- incoming section against whatever previously sat at that ordinal. Insert one
-- section near the top of a document and every section below it shifts down,
-- compares unequal, and has content_changed_at moved to now(). That over-reporting
-- is the SAFE direction for its own consumers (a redundant re-embed, a suppressed
-- verbatim reuse) and a lie for a change log: "12 sections changed on Tuesday"
-- when one paragraph was inserted is worse than no log at all. This table is fed
-- by an independent diff keyed on (document_id, anchor) instead.
--
-- Identity is therefore (document_id, anchor) — the same durable section identity
-- section_citation_usage (0060) and the claim-provenance fold use. A renamed
-- heading reads as a removal plus an addition, which is the honest rendering: the
-- passage a reader could have cited last week is genuinely gone.
--
-- There are deliberately NO foreign keys to documents or document_sections, and
-- proposal_id / job_id are plain text. A change entry must OUTLIVE the row it
-- describes: "this section was removed on 12 August" is precisely an entry whose
-- section no longer exists, and an FK would cascade the history away on the very
-- re-index that created it.
--
-- No backfill, of any kind. The log records forward from install; a backfill from
-- content_changed_at would assert that the whole knowledge base changed on
-- migration day, and one from destination git history would produce entries with
-- no cause attribution and no anchor identity the current parser agrees with.
CREATE TABLE IF NOT EXISTS knowledge_changes (
  id text PRIMARY KEY,
  repository_id text NOT NULL,
  document_id text NOT NULL,
  path text NOT NULL,
  -- Both NULL on a document-level entry (document_added / document_removed).
  anchor text,
  heading text,
  kind text NOT NULL CHECK (
    kind IN ('document_added', 'document_removed', 'section_added', 'section_removed', 'section_changed')
  ),
  changed_at timestamptz NOT NULL DEFAULT now(),
  -- The destination HEAD the change was observed at. NULL when the destination
  -- has no resolvable git context.
  commit_sha text,
  cause text NOT NULL CHECK (cause IN ('gap', 'source_sync', 'patrol', 'seed', 'external')),
  -- Attribution links. Nullable and plain text: attribution is a decoration on an
  -- independently-correct diff, never a dependency of it.
  proposal_id text,
  job_id text,
  -- The upstream commit range that caused the change, when it resolves through
  -- source_sync_runs.
  source_id text,
  source_from_sha text,
  source_to_sha text,
  -- A human label taken from data the system already holds (proposal title, gap
  -- summary, seed plan summary) — never model prose written for this log.
  summary text,
  -- Resolved at write time from the destination, so filtering a flow's feed is an
  -- index scan rather than a join back through configuration.
  flow_id text
);

-- Dedupe key: the same change observed at the same destination commit is ONE
-- entry. The completion replay path deliberately re-runs side effects after a
-- 500, and a merge, a restart, and the PR poller can each drive a re-index, so
-- writes use ON CONFLICT DO NOTHING against this. anchor is NULL on
-- document-level entries, and NULLs are not equal under a plain unique index, so
-- the index is built over COALESCE(anchor, '') to make those dedupe too.
--
-- Partial on commit_sha IS NOT NULL: a destination with no resolvable git context
-- has no commit to key on, and deduping those rows forever on
-- (document_id, anchor, kind) would swallow the SECOND real edit to a section.
-- Those entries fall back to a short-window guard in the store instead.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_changes_dedupe_idx
  ON knowledge_changes (document_id, COALESCE(anchor, ''), kind, commit_sha)
  WHERE commit_sha IS NOT NULL;

-- Serves the store's short-window dedupe probe for entries with no commit_sha.
CREATE INDEX IF NOT EXISTS knowledge_changes_unversioned_dedupe_idx
  ON knowledge_changes (document_id, kind, changed_at DESC)
  WHERE commit_sha IS NULL;

-- The flow feed.
CREATE INDEX IF NOT EXISTS knowledge_changes_flow_changed_at_idx
  ON knowledge_changes (flow_id, changed_at DESC);

-- The per-document timeline.
CREATE INDEX IF NOT EXISTS knowledge_changes_document_changed_at_idx
  ON knowledge_changes (document_id, changed_at DESC);
