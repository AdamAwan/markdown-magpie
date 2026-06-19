# Persistent Gap Reconciliation Service

## Summary

Replace on-demand LLM clustering with one persistent `gaps-to-pull-requests`
reconciler. It runs every 10 minutes, skips all model work when no gaps or
pending publication work changed, and runs as a single claimed job so only one
instance reconciles at a time.

`GET /api/gaps/clusters` becomes a fast database read. The reconciler is the
single job responsible for both clustering and the PR lifecycle: it detects
merged and closed PRs and checks live PR state immediately before every branch
update. The separate `pull-request-refresh` task is absorbed into it, so merge
detection is no longer a second, independently scheduled task.

## Persistent Model

- Add persistent `gap_clusters` and a written `proposals.gap_cluster_id`,
  rebuilding the link that was dropped as dead (never-written) schema in `0015`.
- Add cluster memberships keyed to stable `question_gaps.id` values, with one
  active membership per gap.
- Track active and frozen clusters, lineage, membership changes, model rationale,
  and reconciliation revision.
- Add a transactional gap-catalog revision incremented whenever unresolved
  candidate gaps are added, removed, changed, or resolved.
- Backfill one cluster per existing proposal from its gap summaries and question
  IDs. Merged or rejected proposals become frozen; other proposals remain active.
- Enforce one active membership per gap with a database constraint. During
  backfill a gap may appear in more than one proposal's summaries; the active
  proposal's cluster claims it, and among equally eligible proposals the lowest
  proposal id wins, so every gap lands in exactly one active cluster.
- Add a `superseded` proposal status for PRs replaced through merging or splitting.

## Schema (migration `0016_persistent_gap_clusters.sql`)

These tables are net-new. The old `gap_clusters` table and `proposals.gap_cluster_id`
were dropped as dead schema in `0015` (they were never written); this migration
builds the model that the reconciler actually populates. Conventions match the
existing migrations: `IF NOT EXISTS`, `GENERATED ALWAYS AS IDENTITY`, partial
indexes, and `timestamptz NOT NULL DEFAULT now()`.

```sql
-- Persistent gap clusters. The reconciler is the sole writer; GET /api/gaps/clusters
-- reads from here. A cluster id is a stable surrogate that survives membership
-- changes — the opposite of the on-demand content-hash id it replaces.
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

-- One active membership per gap. Frozen history is kept by clearing `active`,
-- never by moving a gap row out of a frozen cluster.
CREATE TABLE IF NOT EXISTS gap_cluster_memberships (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cluster_id bigint NOT NULL REFERENCES gap_clusters(id) ON DELETE CASCADE,
  gap_id bigint NOT NULL REFERENCES question_gaps(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  rationale text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Enforces the "one active membership per gap" invariant.
CREATE UNIQUE INDEX IF NOT EXISTS gap_cluster_memberships_one_active_idx
  ON gap_cluster_memberships (gap_id) WHERE active;
CREATE INDEX IF NOT EXISTS gap_cluster_memberships_cluster_idx
  ON gap_cluster_memberships (cluster_id) WHERE active;

-- Restore the proposal -> cluster link dropped in 0015, now actually written.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS gap_cluster_id bigint REFERENCES gap_clusters(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS proposals_gap_cluster_id_idx
  ON proposals (gap_cluster_id) WHERE gap_cluster_id IS NOT NULL;

-- Monotonic catalog revision, bumped in the same transaction as any change to the
-- unresolved candidate gaps. The reconciler compares it to its processed revision
-- to decide whether any model work is needed. Single-row tables.
CREATE TABLE IF NOT EXISTS gap_catalog (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO gap_catalog (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS gap_reconciler_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  processed_revision bigint NOT NULL DEFAULT 0,
  last_run_at timestamptz
);
INSERT INTO gap_reconciler_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Outbox of idempotent publication actions, so crashes between DB commit, Git
-- push, and GitHub update can be retried without repeating clustering.
CREATE TABLE IF NOT EXISTS gap_publication_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id text NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('publish', 'supersede')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gap_publication_actions_pending_idx
  ON gap_publication_actions (created_at) WHERE status = 'pending';
```

`proposals.status` has no database CHECK constraint — it is enforced in TypeScript
and Zod — so the new `superseded` status needs no DDL, only the type and schema
edits listed under Files Touched.

Rollback drops the new tables and the restored column in foreign-key-safe order:
`gap_publication_actions`, `gap_cluster_memberships`, `proposals.gap_cluster_id`,
`gap_clusters`, `gap_reconciler_state`, `gap_catalog`.

## Unified Reconciler

- Preserve the existing `gaps-to-pull-requests` scheduled-task key so deployed
  schedule settings continue working; change its default cron to `*/10 * * * *`.
- Run reconciliation as a single claimed job via the existing AI-job claim-lease,
  so at most one runs at a time across instances. The scheduler only enqueues, and
  does not enqueue when a reconciliation job is already pending or running. No
  advisory lock or bespoke mutex is introduced.
- Always check the live state of open PRs and apply merge and close transitions,
  even when model work is skipped. This is the work the former `pull-request-refresh`
  task did, now folded into the single job.
- Skip all model calls when the gap revision is unchanged and no publication action
  is pending.
- Process each flow independently:
  1. Assign new gaps to an existing active cluster or create a new cluster.
  2. Evaluate the complete active cluster set for possible merges and splits.
  3. Send every proposed merge or split to a separate critic model call.
  4. Apply only explicitly confirmed changes with complete member mappings and a
     concrete rationale.
- Keep stable memberships and IDs unchanged when the model proposes no material
  difference.
- Advance the processed revision only after cluster changes are committed.

## Stability And PR Lineage

- Joining a new gap is allowed when one document can reasonably address it with
  the existing cluster.
- Splits require evidence that members represent independently addressable topics;
  merges require evidence that one coherent document can fully cover both clusters.
- Open-PR branches are bot-owned and may have their generated document replaced.
- When clusters merge, the oldest PR survives and is regenerated; other open PRs
  are closed and marked `superseded`.
- When a cluster splits, the largest resulting child retains the original cluster
  and PR. Ties use stable cluster/member ordering. Other children receive new
  clusters and proposals.
- Before pushing or closing anything, fetch each PR's live GitHub state. GitHub
  reports only `open` or `closed` (a merge is `closed` with `merged: true`) and
  not who closed it. Because these PRs are bot-owned and the single job is their
  only writer, the job records the terminal status itself when it supersedes a PR,
  and never re-inspects a proposal already in a terminal status (merged, rejected,
  superseded). A self-initiated close is therefore never misread as a rejection.
  - Open: permit the update.
  - Merged: mark merged, run the existing resolution cascade, freeze the cluster,
    and create successors for uncovered gaps.
  - Closed without merge: mark rejected, freeze the cluster, and create successors
    for uncovered gaps.
  - Unknown or API failure: defer the action without changing the PR or losing
    pending work.

## Proposal Publication

- Replace the current one-shot branch publisher with create-or-update behavior.
- These branches are bot-owned and the job is their only writer, so the remote
  branch tip is always the job's last push. To update, fetch the branch, add one
  normal commit that replaces the generated file, and push. Nothing else commits,
  so the branch can never diverge and a force push can never be needed.
- Regenerate proposal Markdown, gap summaries, evidence, triggering question IDs,
  title, and PR description whenever membership changes.
- Use persisted, idempotent publication actions so crashes between database
  changes, Git pushes, and GitHub updates can be retried safely.
- A run may retry pending publication actions without repeating clustering or
  model calls.
- Manual cluster-to-proposal creation persists the selected cluster and enqueues a
  pending publication action, so it enters the lifecycle even when the gap revision
  is unchanged. It does not rely on a revision bump to be picked up.
- The single job owns all merge and rejection transitions; there is no second
  status-polling task to share them with.

## API And UI

- `GET /api/gaps/clusters` reads active persisted clusters only and performs no
  model work. The response envelope keeps its current `{ clusters: [...] }` shape;
  each cluster keeps every field the on-demand `SuggestedGapCluster` returned and
  gains the persisted fields. The runtime type:

  ```ts
  // packages/core/src/index.ts — replaces the response use of SuggestedGapCluster
  export interface PersistedGapCluster {
    id: string;            // stable surrogate (stringified gap_clusters.id);
                           // stable across membership changes
    title: string;
    summaries: string[];
    questionIds: string[];
    count: number;
    rationale?: string;
    flowId?: string;
    // new persisted fields
    status: "active";      // the endpoint returns active clusters only
    proposalId?: string;
    proposalStatus?: Proposal["status"]; // includes the new "superseded"
    lastReconciledAt?: string;           // ISO; from gap_clusters.updated_at
  }
  ```

- Manual creation moves from summaries to a persisted cluster id. Add
  `POST /api/gaps/clusters/:id/proposal` with body
  `{ targetPath?: string; destinationId?: string }`; it persists the proposal,
  links `proposals.gap_cluster_id`, and enqueues a `publish` publication action.
  The existing `POST /api/proposals/from-gap(s)` path stays for ad-hoc drafting.
- `Proposal["status"]` gains `"superseded"` in both `packages/core/src/index.ts`
  and the Zod enum in `apps/api/src/features/proposals/schema.ts`.
- The page-wide refresh no longer waits on a chat completion.
- The `gaps-to-pull-requests` scheduled-task description is rewritten to say it
  reconciles gaps, clusters, proposals, and open PRs (clustering, merge/close
  detection, and publication in one job); the separate `pull-request-refresh`
  entry is removed from the registry.

## Failure Handling

- Cluster mutations are transactional; model failures leave the prior clustering
  intact.
- External Git and GitHub operations use an outbox-style pending-action record and
  retry on later runs.
- Re-fetch PR state immediately before each external mutation.
- Never move a gap out of frozen cluster history; successors reference unresolved
  gap rows through new active memberships.
- Reset clears publication actions, cluster history and memberships, clusters,
  proposal links, and reconciliation revision in foreign-key-safe order.

## Test Plan

- Verify unchanged gap revisions cause no model calls (live PR-state checks still run).
- Verify concurrent manual and scheduled triggers enqueue and claim a single
  reconciliation job, so the work never runs twice.
- Verify new gaps join suitable clusters or create new ones within their flow.
- Verify unconfirmed merges and splits make no changes; critic-confirmed reshapes
  preserve every gap exactly once.
- Verify merge lineage keeps the oldest PR and supersedes the others, and that a
  superseded proposal is never re-inspected or downgraded to rejected.
- Verify split lineage keeps the largest child on the original PR.
- Verify open PRs update, while merged or closed PRs freeze and produce successors.
- Verify a PR state change between reconciliation and publication prevents the push.
- Verify failed pushes remain pending and retry without another model call.
- Verify existing proposal backfill and migration rollback safety.
- Verify `/gaps/clusters` performs only store reads and returns promptly.
- Run unit tests for reconciliation decisions, PostgreSQL integration tests for
  single-job claim-lease, revisions, and migrations, Git publisher tests for branch
  updates, API tests, typecheck, lint, and the full workspace suite.

## Files Touched (anticipated)

- `packages/db/migrations/0016_persistent_gap_clusters.sql` — new clusters,
  memberships, catalog/reconciler-state, and publication-action tables; restore
  `proposals.gap_cluster_id`.
- `packages/core/src/index.ts` — add `"superseded"` to `Proposal["status"]`; add
  the `PersistedGapCluster` type; the now-live `Proposal.gapClusterId` field.
- `apps/api/src/features/proposals/schema.ts` — add `"superseded"` to the status
  Zod enum.
- `apps/api/src/stores/proposal-store.ts` + `postgres-proposal-store.ts` — read and
  write `gap_cluster_id` again; support the `superseded` status; reset clears it.
- **New** `apps/api/src/stores/gap-cluster-store.ts` (+ `postgres-` impl + in-memory)
  — clusters, memberships, catalog revision, reconciler state, and the publication
  outbox; a `reset()` that clears them in FK-safe order.
- `apps/api/src/stores/postgres-question-log-store.ts` and
  `apps/api/src/features/proposals/service.ts` — bump `gap_catalog.revision` in the
  same transaction as any insert/resolve of unresolved gaps.
- `apps/api/src/features/gaps/service.ts` — `listClusters` reads persisted clusters
  (no model call); on-demand clustering helpers move into the reconciler.
- `apps/api/src/features/gaps/routes.ts` — unchanged `/clusters` envelope; add the
  manual `POST /clusters/:id/proposal` route.
- **New** `apps/api/src/scheduling/gap-reconciler.ts` — the single job: assign/merge/
  split decisions, the separate critic call, lineage, live PR-state check, cascade,
  and outbox processing.
- `apps/api/src/scheduling/task-registry.ts` — change `gaps-to-pull-requests`
  default cron to `*/10 * * * *`, fold the merge/close detection in, rewrite the
  description, and remove the `pull-request-refresh` entry.
- `apps/api/src/stores/gap-clustering.ts` — reuse the pure title/grouping helpers;
  the content-hash `clusterId` is superseded by persisted surrogate ids.
- `packages/git/src/index.ts` — `LocalGitProposalPublisher` becomes create-or-update
  (fetch existing branch, commit the regenerated file on top, push) instead of
  `assertBranchDoesNotExist`.
- `docs/api.md` — document the extended `/gaps/clusters` response and the new
  manual cluster-to-proposal endpoint.
- New/updated `*.test.ts` — reconciler decisions (unit), `gap-cluster-store`
  (Postgres/Testcontainers), publisher branch-update, and API tests per the Test
  Plan.

## Assumptions

- GitHub is the only host currently supporting live PR inspection and closure.
- Open PR branches are exclusively bot-owned; replacing their generated file is
  acceptable.
- Full cluster reshaping is allowed until the associated PR closes or merges.
- The oldest PR survives merges; the largest child survives splits.
- Destructive reshaping always requires separate propose and verify model calls.
- Default cadence is 10 minutes, while existing explicitly saved cron settings
  remain unchanged.
