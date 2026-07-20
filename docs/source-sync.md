# Source Sync

> **Status:** living spec (as-built). Source of truth for keeping a flow's knowledge base
> in step with changes to its **upstream source repositories** (as opposed to gap-driven
> authoring). Follows the [spec conventions](./README.md#conventions).

## Purpose

When a flow's source repository changes, source sync detects the diff, retrieves the
derived knowledge docs it likely affects, and generates a proposal that updates them —
converging on the same reconcile gate and publish path as every other lens
([proposals-and-publishing.md](./proposals-and-publishing.md)). It runs as a scheduled
maintenance job, per flow, per source.

## Trigger & change detection

- **S1** — The `source_change_sync` scheduled maintenance job (`*/10 * * * *`,
  capability `maintenance`) drives one run **per git source** of the flow. A watcher
  POSTs `/api/source-sync/run`, a thin orchestration endpoint; the generative work is a
  separate provider job (S4).
- **S2** — Change detection compares the source's current `HEAD` against a stored cursor
  `(flowId, sourceId).lastSha` in `source_sync_state`. The **first** sighting of a source
  *baselines* it (records HEAD, generates nothing). An unchanged SHA is a no-op. A changed
  SHA produces a file diff (`diffChangedFiles`), bounded by
  `SOURCE_SYNC_MAX_CHANGED_FILES` (default 1000) and a per-file patch cap.
- **S3** — Diffs are NUL-byte-sanitized before persistence (Postgres JSONB rejects NUL),
  preventing a binary change from wedging the run.

## Sync flow (first-class proposal, through the gate)

- **S4** — After a diff, retrieval selects candidate KB docs (capped by
  `CANDIDATE_DOCUMENT_LIMIT`). Zero candidates → the run is `skipped` and the baseline
  advances. Otherwise the API enqueues one `sync_source_changes_generate_plan` provider
  job carrying the diff and candidate documents, records a `running` run linked to the job
  id, and advances the baseline. If the fan-out budget **sheds** the job, the source is
  deferred (no run, baseline **not** advanced) and re-diffs next tick.
- **S5** — On completion, the plan is constrained to the offered candidate docs
  (defence-in-depth: it can only touch documents it was shown, never delete outside them).
  An empty changeset marks the run `skipped`; otherwise the API creates (or reuses, by job
  id) a proposal and hands it to the reconcile gate via `reconcileSourceSyncProposal`.
- **S6** — Source-sync produces a **first-class proposal** and converges on the shared
  reconcile gate → `publish_proposal` path (fold into a touchable open PR, defer behind an
  approved one, or open a new PR). There is **no `publish_source_sync` job and no
  source-sync-specific publish path** — the only source-sync job types are
  `source_change_sync` and `sync_source_changes_generate_plan`.
- **S7** — A run's status is exactly `running | completed | failed | skipped`. Double-
  publish is prevented by an atomic `completeRun` (`UPDATE … WHERE status='running'
  RETURNING *`, so only the transitioning caller proceeds), create-or-reuse of the
  proposal by job id, and the publish-job dedup in `enqueuePublishProposal`.

## Source maps (source-agentic grounding)

- **S8** — Source-grounded jobs read their source repositories directly from **read-only
  workspaces** on the shared checkout volume (resolved from each job's
  `SourceDescriptor[]`), via a bounded read-only tool loop (`list_dir` / `read_file` /
  `grep`, step and byte budgets). Tool access is realpath-contained against `..` and
  symlink escapes.
- **S9** — A **source map** is agent-maintained navigation metadata keyed
  `(sourceId, topic)` — lightweight, topic-indexed hints stored in Postgres. It is
  populated as a completion side-effect of the six source-grounded job types
  (`draft_seed_document`, `draft_markdown_proposal`, `outline_flow_seed`,
  `verify_document`, `correct_document`, `improve_document`) — **not** by
  `sync_source_changes_generate_plan`. Concurrent writers merge per topic; a consensus
  count (Jaccard > 0.5, capped at 5) tracks agreement. Write caps bound updates per job
  and entries per source.
- **S10** — Source maps are **internal navigation metadata only**: fetched by the watcher
  through the scoped-context callback `GET /api/source-map` (`manage:jobs`) and injected
  into source-grounded prompts framed as unverified hints to be verified against the
  repository before being relied on. They MUST NOT appear in answer retrieval or any
  user-facing output.

## Job contracts

- **S11** — `source_change_sync` — capability `maintenance`, expiry 1h, `*/10 * * * *`.
- **S12** — `sync_source_changes_generate_plan` — capability `provider`, expiry 1h,
  enqueued on demand per changed source. Input carries `{sourceId, fromSha, toSha,
  changes[], candidateDocuments[], expectedOutput: "maintenance_plan"}`; output is a
  `MaintenancePlan` (`{summary, operations[], rationale}`).

## Key constants

| Constant | Default | Where |
| --- | --- | --- |
| `SOURCE_SYNC_MAX_CHANGED_FILES` | 1000 | `apps/api/src/features/source-sync/service.ts` |
| `CANDIDATE_DOCUMENT_LIMIT` | 6 | `apps/api/src/features/source-sync/service.ts` |
| `RETRIEVAL_SECTION_LIMIT` | 12 | `apps/api/src/features/source-sync/service.ts` |
| source-map write cap / entries per source | 20 / 200 | `apps/api/src/features/source-map/service.ts` |
| source-map consensus threshold / cap | 0.5 / 5 | `apps/api/src/stores/source-map-consensus.ts` |
| source-agent step / read budget | 24 / 400 KB | `apps/watcher/src/runners/source-agent.ts` |

## HTTP endpoints

- `GET /api/source-sync/runs` (`read:knowledge`), `GET /api/source-sync/runs/:id`
  (`read:knowledge`, 404 `source_sync_run_not_found`).
- `POST /api/source-sync/run` (`manage:jobs`, rate-limited; optional `{flowId}`; returns
  `{runIds}`).
- `GET /api/source-map?sourceIds=` (`manage:jobs`; 400 `source_ids_required` if empty).
- (Retired: `GET /api/source-sync/runs/:id/execution-context`.)

## Code map

| Concern | Code |
| --- | --- |
| Orchestration & helpers | `apps/api/src/features/source-sync/{service,routes}.ts` |
| Diff / checkout | `packages/git/src` (`diffChangedFiles`, `getHeadSha`, `ensureGitCheckout`) |
| Cursor store | `apps/api/src/stores/{source-sync-store,postgres-source-sync-store}.ts` (`source_sync_state`) |
| Source-map store & routes | `apps/api/src/stores/{source-map-store,source-map-consensus}.ts`, `apps/api/src/features/source-map/{service,routes}.ts` |
| Watcher runner & agent | `apps/watcher/src/runners/{maintenance,source-agent}.ts`, `apps/watcher/src/{source-workspace,source-tools}.ts` |
| Reconcile hand-off | `apps/api/src/scheduling/fold.ts` (`reconcileSourceSyncProposal`) |
| Schedule registration (`*/10 * * * *`) | `apps/api/src/scheduling/task-registry.ts` (`defaultCron` on the `source-change-sync` template) |
| Job contracts | `packages/jobs/src/{schemas,catalog}.ts` |

## Tests (behavioural contract)

`apps/api/src/features/source-sync/{orchestration,git-diff,service,routes}.test.ts`,
`apps/api/src/stores/{source-sync-store,postgres-source-sync-store,source-map-store,postgres-source-map-store}.test.ts`,
`apps/watcher/src/runners/{source-agent,maintenance}.test.ts`.

## Provenance (design history)

Consolidates: `docs/superpowers/specs/2026-06-18-source-change-sync-design.md`
(detection half — still broadly accurate), `2026-06-24-source-sync-through-gate-design.md`
and `2026-06-28-source-sync-first-class-proposal-design.md` (the current end state),
`2026-07-06-source-agentic-grounding-design.md` (source maps / workspaces).

> **Drift found while writing:** the `2026-06-24-source-sync-double-publish-race-design.md`
> doc is **fully stale** — its `deferred` run status and the
> `regateDeferredRuns`/`enqueuePublication`/`publish_source_sync` machinery it describes do
> not exist in the code. The race is instead guarded by the atomic `completeRun`
> transition, create-or-reuse-by-job-id, and the publish-job dedup (S7). Do not implement
> from that doc.
