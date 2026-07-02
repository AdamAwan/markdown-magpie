-- Off-topic questions (e.g. asking a product knowledge base about cats) must not
-- linger as knowledge gaps. The gap reconciler now dismisses clusters it judges
-- unrelated to the source knowledge: the cluster moves to a terminal 'dismissed'
-- state, its member gaps are stamped dismissed (so they stop surfacing as
-- candidates and never re-cluster), and the decision is recorded with kind
-- 'dismiss'.

-- 1) Gaps: a terminal dismissal marker, parallel to resolved_at but for off-topic
-- rather than covered. Retained for audit; excluded from the candidate query.
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
ALTER TABLE question_gaps ADD COLUMN IF NOT EXISTS dismissed_reason text;

-- 2) Clusters: allow the terminal 'dismissed' status alongside active/frozen.
ALTER TABLE gap_clusters DROP CONSTRAINT IF EXISTS gap_clusters_status_check;
ALTER TABLE gap_clusters ADD CONSTRAINT gap_clusters_status_check
  CHECK (status IN ('active', 'frozen', 'dismissed'));

-- 3) Reconciliation decisions: allow the 'dismiss' kind alongside merge/split.
ALTER TABLE reconciliation_decisions DROP CONSTRAINT IF EXISTS reconciliation_decisions_kind_check;
ALTER TABLE reconciliation_decisions ADD CONSTRAINT reconciliation_decisions_kind_check
  CHECK (kind IN ('merge', 'split', 'dismiss'));
