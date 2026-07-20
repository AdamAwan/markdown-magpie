# Gaps & Maintenance

> **Status:** living spec (as-built). Source of truth for how weak answers become
> knowledge gaps, how gaps are clustered and reconciled into proposals, and how the
> scheduled patrols keep the knowledge base correct. Follows the
> [spec conventions](./README.md#conventions).

## Purpose

Close the loop between "a question the corpus could not answer well" and "a merged
document that answers it." Gaps are raised from weak answers (and other sources),
clustered, drafted into proposals by the reconciler, and — after merge — **verified**
to have actually closed. In parallel, hourly **patrols** sweep existing documents for
correctness and editorial issues. All generative work is queue-only
([ai-jobs.md](./ai-jobs.md)); the orchestration lives in the API and fans out to
watcher jobs.

## Gap lifecycle

- **G1** — A gap row (`question_gaps`) has one of five **sources**: `auto` (the model
  declared a whole-question gap), `followup` (a search observably returned empty),
  `manual` (an admin flag), `verification` (server-raised on a failed gap-closure
  re-ask), or `feedback` (user feedback signal). `auto` ships at `low` confidence, or
  `medium` for a substantive partial.
- **G2** — Gap state is **column-modeled**, not an enum. A gap is a live candidate when
  `resolved_at IS NULL AND dismissed_at IS NULL` and its question has no live `parked_at`
  row. `listGapCandidates` groups candidates by `(summary, flow_id)`.
- **G3** — On re-answer, a question's `auto`/`followup` gap rows are deleted and
  rewritten; `manual` and `verification` rows are preserved. The empty-KB fallback
  summary (a summary echoing the raw question) MUST be dropped at ingestion so a batch of
  unanswered questions does not each seed a singleton cluster.
- **G4** — **Resolve**: `resolveGaps` stamps `resolved_at` + `resolved_by_proposal_id`
  and bumps the flow's gap-catalog revision. A gap is resolved by `(question, summary)`
  and **only once** the merge's closure verification passes (see G20).
- **G5** — **Dismiss**: `dismissGaps` stamps `dismissed_at`. It MUST NOT dismiss a row
  whose question is parked.
- **G6** — **Park**: after `CLOSURE_RETRY_CAP = 2` failed verifications for the same
  question, its `verification` gap is stamped `parked_at` (reason `"verification retry
  cap"`). A live parked row removes the **whole question** from gap candidacy — a
  first-class "awaiting a human" state, not a source. A human retries
  (`POST /api/questions/:id/gap/retry`) or dismisses it from the console's Parked panel.
- **G7** — On boot, `backfillGapClusters` gives every pre-existing proposal a cluster
  (idempotent; settled statuses frozen).

## Gap clustering (phase-1 pre-clusterer)

- **G8** — Before the reshape, each unassigned gap's summary is embedded **inline**
  (the sanctioned inline exception) and compared, **within its flow only**, against each
  active cluster's stored representative embedding (the L2-normalised centroid of the
  cluster's distinct member summaries).
- **G9** — A gap joins the nearest cluster at or above `GAP_CLUSTER_ASSIGN_THRESHOLD`
  (**default 0.84**, tuned by `scripts/eval-gap-threshold.ts`). Unmatched gaps form
  connected components (pairwise cosine ≥ threshold), each seeding one new cluster titled
  from its lexicographically-first summary.
- **G10** — Assignment MUST be **order-independent and deterministic**: candidates are
  key-sorted, decisions are made against a tick-start snapshot of representatives, ties
  break to the older cluster, so a re-raised identical gap re-lands the same way.
- **G11** — The threshold is deliberately conservative — phase 1 banks only near-
  duplicate rewordings and leaves genuine paraphrase consolidation to the reshape critic.
- **G12** — With **no embedding provider**, clustering falls back to one cluster per
  distinct summary. If a provider is configured but an embed call **fails**, the tick
  fails and retries — it MUST NOT silently fan out singletons.
- **G13** — A cluster whose composition changes (merge, split, resolved-gap pruning) has
  its representative embedding nulled and lazily recomputed from surviving members.

## The reconciler

Entry: `reconcileGaps` (`POST /api/gaps/reconcile`), driven by the
`process_gaps_to_pull_requests` maintenance job (~10 min cron).

- **G14** — A reconcile run for a flow MUST hold a Postgres **session-level advisory
  lock** keyed on `(taskType, flowId)` for the whole run. An overlapping run for the same
  flow is refused the lock and skips quietly (only the holder records a `MaintenanceRun`);
  a different flow reconciles in parallel. Because the lock lives in Postgres it
  serializes across API replicas.
- **G15** — Order within a run: refresh open-PR state → sweep unverified merged proposals
  → detect overlaps/cross-link → **revision gate** → (if the gap catalog advanced)
  prune resolved memberships, freeze emptied clusters, phase-1 assign, reshape, draft
  uncovered clusters → drain the publication outbox.
- **G16** — **Revision gate**: if the flow's gap-catalog revision equals the last
  processed revision and there are no pending actions, the run does the PR-state pass only
  and skips clustering/reshape/drafting.
- **G17** — **Reshape** (the only generative step) is a provider-partitioned
  `reconcile_gap_clusters` AI job the API enqueues and bounded-waits on: it proposes
  merges/splits/**dismissals**, then a critic confirms. It runs whenever ≥1 active
  cluster exists. A critic-confirmed **dismissal** moves an off-topic cluster to a
  terminal `dismissed` state (e.g. a "cats" cluster in a product flow) so it never drafts
  and never re-clusters. Reshape is **best-effort**: a timeout/failure/absent-watcher
  leaves the raw clusters intact and the run continues.
- **G18** — **Composition short-circuit**: before enqueuing the reshape, the reconciler
  hashes the active cluster composition (sorted cluster ids each paired with sorted member
  gap ids) and compares it to `last_reshape_composition_hash`. An identical hash means the
  critic already judged this exact set, so the reshape is skipped. The hash is written
  **only after a completed reshape**, so a skipped/failed/malformed reshape never wedges
  the gate.
- **G19** — **Fan-out containment**: new drafts are bounded to `MAX_DRAFTS_PER_TICK = 10`
  per flow per tick; when more uncovered clusters remain the reconciler drafts a capped
  batch, warns, and holds the processed revision so a later tick drains the rest. An
  in-flight `draft_markdown_proposal` job counts as **covering** its cluster, so an
  overlap never enqueues a duplicate full generation.

## Merge cascade & gap-closure verification

- **G20** — A merge MUST NOT blindly resolve the gaps a proposal set out to close. The
  merge cascade (shared by the local-git **Accept** action and the PR poller) re-indexes
  the destination, then — for any proposal that had triggering questions — enqueues a
  `verify_gap_closure` job (enqueued **on merge**, never on a cron).
- **G21** — Verification **re-asks each triggering question** through the normal
  queue-only `answer_question` path against the updated index. A question is **closed**
  only when the re-ask returns a confident answer (`high`/`medium`) that **cites one of
  the merged proposal's target docs** and raises no new `auto` gap.
- **G22** — Aggregate outcome: all questions close → gaps resolved
  (`verified_closed`); any stays open → gaps **reopened** with the verification detail as
  a note (`reopened`); after the retry cap the question is parked
  (`needs_attention`, see G6). Clusterless/seed proposals have no triggering questions and
  skip verification.
- **G23** — **Single-watcher safety**: an incomplete re-ask (the orchestrator's inner AI
  job can only be claimed by a *second* watcher) MUST be reported as infrastructure
  failure — the endpoint returns **503** and the job retries — never recorded as a
  `still_open` content verdict that would wrongly reopen a correctly-merged doc. The
  console warns when only one watcher is connected. Maintenance orchestrators therefore
  need **at least two watchers**.

## The patrols

- **G24** — **`correctness_patrol`** (hourly, `maintenance`) selects a cursor batch
  (oldest-checked-first exploit + random explore; `PATROL_BATCH_SIZE = 10`,
  `PATROL_RANDOM_COUNT = 2`), drops open-PR-covered docs, applies a content+sources change
  gate, then runs the **verify lens** (`verify_document`) per doc and fans into
  `correct_document` (per finding), `dedupe_documents`, and `split_document`.
- **G25** — **`editorial_patrol`** (hourly, `maintenance`) uses a separate cursor and a
  smaller batch (`IMPROVE_PATROL_BATCH_SIZE = 2`) and fans into one `improve_document`
  per doc.
- **G26** — The former whole-knowledge-base **Crunch** pass is retired; its
  consolidate/split responsibilities now live in the patrols and the reconciler.

## The reconcile gate (`ChangeIntent`)

- **G27** — Every document-writing producer — gap drafts, corrective (verify), seed,
  dedupe, split, source-sync, and improve proposals — MUST express a `ChangeIntent` and
  pass through the **reconcile gate** before a `publish_proposal` job opens or updates a
  PR, so all producers converge on one mechanism.
- **G28** — The gate `decideReconciliation(intent, openPrs)` returns
  **`open-new` | `fold` | `defer` | `drop`**. It folds into the most-overlapping
  *touchable* open PR (a PR is touchable when its review decision is not `approved`),
  defers when all overlapping PRs are approved/locked, and otherwise opens a new PR.
  Folds route through `fold_markdown_proposal` (single-file) or `fold_changeset_proposal`
  (multi-file). Publishing itself is specified in
  [proposals-and-publishing.md](./README.md).

## Scheduled-task model

- **G29** — Background tasks are registered **per flow**: each template expands to one
  concrete task per configured flow (`github`-only templates are skipped for local-git
  flows). The model is **two-tier** — each scheduled task fires *exactly one* orchestrator
  job on its cron (tier 1); maintenance orchestrators fan out into the provider AI +
  GitHub jobs that do the real work (tier 2). The job-type identifier is the pg-boss queue
  name, so the same string names the Schedules row, the dataflow box, and the job-queue
  `type=` filter.

| Task (baseKey) | Job type (= queue name) | Cron | Capability | Fans out into |
| --- | --- | --- | --- | --- |
| gaps-to-pull-requests | `process_gaps_to_pull_requests` | `*/10 * * * *` | maintenance | `reconcile_gap_clusters`, `draft_markdown_proposal` |
| source-change-sync | `source_change_sync` | `*/10 * * * *` | maintenance | `sync_source_changes_generate_plan` |
| snapshot-refresh | `refresh_flow_snapshot` | `*/5 * * * *` | github (github-only) | — (leaf) |
| fix-patrol | `correctness_patrol` | `0 * * * *` | maintenance | `verify_document` → `correct_document`, `dedupe_documents`, `split_document` |
| improve-patrol | `editorial_patrol` | `0 * * * *` | maintenance | `improve_document` |
| seed-bootstrap | `seed_bootstrap` | `0 * * * *` | maintenance | `outline_flow_seed` |

- **G30** — `verify_gap_closure` is the one maintenance job **not** on a cron — it is
  enqueued on merge (G20).

> **Naming note (intentional, not drift):** the job types were renamed
> (`fix_patrol` → `correctness_patrol`, `improve_patrol` → `editorial_patrol`,
> `refresh_pull_requests` → `refresh_flow_snapshot`), but the HTTP surface is still
> `/api/fix-patrol/*` and the registry `baseKey`s are still `fix-patrol`/`improve-patrol`.
> Both facts are true at once — do not "fix" the endpoint path to match the job type.

## Key constants

| Constant | Default | Where |
| --- | --- | --- |
| `GAP_CLUSTER_ASSIGN_THRESHOLD` | 0.84 | `apps/api/src/platform/config.ts` |
| `MAX_DRAFTS_PER_TICK` | 10 | `apps/api/src/scheduling/gap-reconciler.ts` |
| `CLOSURE_RETRY_CAP` | 2 | `apps/api/src/features/proposals/service.ts` |
| `PATROL_BATCH_SIZE` / `PATROL_RANDOM_COUNT` | 10 / 2 | `apps/api/src/features/patrol/service.ts` |
| `IMPROVE_PATROL_BATCH_SIZE` / `_RANDOM_COUNT` | 2 / 1 | `apps/api/src/features/patrol/service.ts` |
| `VERIFY_WAIT_BUDGET_MS` | 10 min | `apps/api/src/features/patrol/service.ts` |
| `WATCHER_MAINTENANCE_TIMEOUT_MS` | 15 min | `apps/watcher/src/config.ts` |
| `MAGPIE_AGENTIC_TIMEOUT_MS` | 10 min | `apps/watcher/src/runners/index.ts` |

## HTTP endpoints

- `GET /api/gaps/candidates`, `GET /api/gaps/clusters`, `POST /api/gaps/reconcile`,
  `POST /api/gaps/clusters/:id/proposal` (`manage:jobs`).
- `POST /api/fix-patrol/run`, `POST /api/fix-patrol/improve/run` (`manage:jobs`).
- `POST /api/proposals/:id/verify-closure` (`manage:jobs`; returns 503
  `gap_closure_verification_incomplete` on an incomplete re-ask, G23).
- `POST /api/questions/:id/gap`, `DELETE /api/questions/:id/gap`,
  `POST /api/questions/:id/gap/retry`, `POST /api/questions/:id/gap/dismiss`.
- `GET /api/maintenance-runs`, `GET /api/scheduled-tasks` (with run-now),
  `GET /api/reconciliations`.

See [api.md](./api.md) for the full reference and [question-logging.md](./question-logging.md)
for gap sources and the parked-question workflow.

## Code map

| Concern | Code |
| --- | --- |
| Gap store & lifecycle | `apps/api/src/stores/postgres-question-log-store.ts`, `apps/api/src/features/questions/` |
| Clustering (pure geometry) | `apps/api/src/scheduling/gap-assignment.ts`, `apps/api/src/stores/gap-cluster-store.ts` |
| Reconciler | `apps/api/src/scheduling/gap-reconciler.ts`, `apps/api/src/features/gaps/` |
| Advisory lock | `apps/api/src/scheduling/run-lock.ts` |
| Reshape / cluster ops | `apps/api/src/scheduling/gap-reconciler.ts` (`requestReshape`, `applyMerge/Split/Dismissal`) |
| Patrols & lenses | `apps/api/src/features/patrol/service.ts`, `apps/api/src/scheduling/{verify,dedupe,split}-lens*.ts`, `patrol-cursor.ts`, `patrol-hash.ts` |
| Closure verification | `apps/api/src/features/proposals/service.ts`, `closure-eval.ts`, `apps/api/src/stores/postgres-gap-closure-verification-store.ts` |
| Reconcile gate / intent | `apps/api/src/scheduling/{reconcile-gate,changeset,fold,intent,intent-trace}.ts` |
| Scheduled tasks | `apps/api/src/scheduling/task-registry.ts`, `packages/jobs/src/{types,catalog}.ts` |

## Tests (behavioural contract)

`apps/api/src/scheduling/{gap-reconciler,gap-reconciler-lineage,gap-reconciler-link,gap-reconciler-merge-cascade,gap-reconciler-overlap,gap-assignment,gap-backfill,reconcile-gate,run-lock,changeset,fold,intent,intent-trace,verify-lens,dedupe-lens,dedupe-neighbours,split-lens,split-neighbours,patrol-cursor,patrol-hash,task-registry}.test.ts`,
`apps/api/src/stores/{gap-cluster-store,postgres-gap-cluster-store,gap-clustering,postgres-gap-closure-verification-store,question-log-store,postgres-question-log-store,patrol-store,maintenance-run-store,scheduled-task-store}.test.ts`,
`apps/api/src/features/proposals/{closure-eval,service,link-cluster,routes.merge}.test.ts`,
`apps/api/src/features/patrol/service.test.ts`,
`apps/api/src/features/gaps/{service,routes}.test.ts`,
`packages/jobs/src/catalog.test.ts`.

## Provenance (design history)

Consolidates: `docs/superpowers/specs/2026-06-18-persistent-gap-reconciliation-design.md`,
`2026-07-07-gap-embedding-bucketing-design.md`, `2026-07-04-gap-closure-verification-design.md`,
`2026-07-05-parked-gap-human-workflow-design.md`, `2026-06-24-verify-lens-design.md`,
`2026-06-25-dedupe-lens-design.md`, `2026-06-26-split-lens-design.md`,
`2026-06-26-improve-patrol-design.md`, `2026-06-26-retire-scheduled-crunch-design.md`,
`2026-06-26-maintenance-run-audit-design.md`, `2026-06-24-source-sync-through-gate-design.md`,
`2026-06-23-fold-at-draft-design.md`. The whole-KB *Crunch* pass those docs sometimes
reference is retired (G26); patrol job types were renamed (see the naming note).
