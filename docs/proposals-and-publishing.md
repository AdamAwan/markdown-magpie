# Proposals & Publishing

> **Status:** living spec (as-built). Source of truth for the proposal entity and its
> lifecycle from draft through publish, merge, and closure. Follows the
> [spec conventions](./README.md#conventions). The gap/cluster/reconciler and the
> reconcile gate that *feed* proposals are in
> [gaps-and-maintenance.md](./gaps-and-maintenance.md); this spec picks up where a
> reconciled proposal enters publishing.

## Purpose

A **proposal** is a proposed change to the knowledge base (a single-file document write,
or a multi-file changeset). Every producing lens — gap draft, corrective, seed, dedupe,
split, improve, source-sync — converges on the proposal entity, which is published to a
Git branch and (when a host token is configured) raised as a pull request. The *merge*
that changes the source of truth is always a human action.

## Proposal entity & lifecycle

- **P1** — A proposal's `status` is exactly one of
  `draft | ready | branch-pushed | pr-opened | merged | rejected | superseded`
  (`PROPOSAL_STATUSES`). There is no `published`, `closed`, or `needs_attention`
  *status*. Terminal statuses are `merged | rejected | superseded`; terminal proposals
  are hidden from the default inbox but fetchable via `?status=`.
- **P2** — A newly created proposal is always `draft`. Publishing sets `pr-opened` when a
  PR URL is present, else `branch-pushed`. A merge sets `merged` (stamping `merged_at`
  once). A PR closed without merging maps to `rejected`. A no-op publish maps to
  `superseded` (P14).
- **P3** — `closureStatus` (`verified_closed | reopened | needs_attention`) is a
  **separate field** from `status`, set by gap-closure verification
  ([gaps-and-maintenance.md#G22](./gaps-and-maintenance.md)). `needs_attention` is a
  closure status, not a proposal status.
- **P4** — A single-file proposal carries `targetPath` + `markdown`; a multi-file
  proposal carries a `changeset`, which is then the source of truth. A proposal may carry
  a `gapClusterId` (gap-driven) or be **clusterless** and carry `flowId` + `seedPlanId`
  (seed) or be a lens output (correct/improve).

## Draft generation

- **P5** — `draft_markdown_proposal` is enqueue-only; the proposal row lands later via
  the job-completion handler. Draft input unions evidence and triggering questions across
  the matched gap candidates and resolves the flow, destination, and sources.
- **P6** — When a draft input carries `regenerateProposalId`, completion MUST update the
  existing proposal in place (bumping `regenerationCount`, keeping title/targetPath) and
  re-publish — it MUST NOT create a new proposal row (see P13).

## Per-claim provenance

- **P7** — Every draft returns a structured `provenance` array — each substantive claim
  (a short restatement, keyed by `anchor ?? claim`) plus the source locations that ground
  it. The **document body carries no provenance**; only the PR body and history do, so
  internal source paths never leak into published content.
- **P8** — Provenance is **append-only, event-log semantics**: a merged proposal's row
  *is* the provenance event for its `targetPath`. `foldProvenanceEvents` folds merged
  proposals oldest-first into the current advisory claims, later events superseding
  earlier per `(anchor ?? claim)` and dropping claims whose anchor no longer exists.
- **P9** — A missing provenance array **warns, never blocks** publication.

## Publishing path

- **P10** — `POST /api/proposals/:id/publish` requires `status === "ready"` (else 409
  `proposal_not_ready`), validates the repository, then enqueues a `publish_proposal` job.
  The job fans over the destination: a `file://` destination routes to `local-git`, else
  `github`. An in-flight publish for the same proposal id is deduped.
- **P11** — The watcher's publication runner (capability `github`) owns the checkout,
  derives the branch name locally (`magpie/proposal-<id8>-<slug40>`), commits via a temp
  worktree, and pushes. For a `github` destination it raises a PR, **degrading to
  branch-only** if the PR call fails or no token resolves; `local-git` skips the PR step.
  The API stores whatever `branchName` the watcher returns — it does not derive branches
  itself.
- **P12** — Committer identity is required (`MAGPIE_GIT_AUTHOR_NAME` /
  `MAGPIE_GIT_AUTHOR_EMAIL`); the publisher throws if unset. Publishes are ordinary queued
  `publish_proposal` jobs — there is no separate "publications outbox" store; the reconcile
  gate re-publishes folded survivors through the same `enqueuePublishProposal` path.

## Stale-PR auto-regeneration

- **P13** — When a `refresh_flow_snapshot` poll reports a PR's `mergeable_state` as
  **conflicting**, the API MAY regenerate the proposal against the fresh base (a single-
  file proposal is a whole-file write, so a conflict means that file changed on `main` —
  the fix is regeneration, not a textual merge). It enqueues a `draft_markdown_proposal`
  keyed with `regenerateProposalId`; on completion it updates the proposal in place and
  re-publishes with `regenerate: true`, which re-cuts the branch from the current base tip
  and force-pushes (`--force-with-lease`), keeping the proposal id, title, target path,
  and open PR.
- **P14** — Regeneration is guarded: it applies only to `pr-opened`/`branch-pushed`
  proposals; an **approved** PR is never rewritten; a per-proposal retry cap
  (`REGENERATION_CAP = 3`, via `regenerationCount`) stops a structural conflict from
  looping; it is **single-file only**; and at most **one** regeneration may be in flight
  per proposal. It is effectively GitHub-only (local-git has no polled `mergeable_state`).

## No-op publish

- **P15** — A fresh-branch publish whose generated content is byte-identical to the base
  is not an error: the publisher returns the base tip flagged `noChange`, the watcher
  skips the PR step, and the API settles the proposal as **`superseded`** (terminal,
  hidden from the inbox) rather than recording a branch that was never pushed.

## PR state tracking & merge/accept

- **P16** — `refresh_flow_snapshot` (capability `github`, ~5 min, github-only) lists open
  PRs and records each one's merged/state/mergeable reading plus, for still-open PRs, its
  `reviewDecision` (`approved | changes_requested | review_required | none`). Only
  `approved` locks a PR against folding. The API holds no GitHub token — the watcher
  reports these readings and the API persists the snapshot.
- **P17** — `applyPullRequestTransition` owns the terminal transitions: a merged PR →
  `merged` + merge cascade ([G20](./gaps-and-maintenance.md)) + freeze cluster; a
  closed-without-merge PR → `rejected` + freeze. It is shared by the reconciler and the
  snapshot-completion handler and is replay-safe.
- **P18** — A manual `POST /api/proposals/:id/status` = `merged` is rejected (409
  `proposal_merge_tracked_by_pull_request`) when the proposal has a PR URL — GitHub owns
  that transition. **Local-git** flows instead use `POST /api/proposals/:id/merge`
  (`--no-ff --no-edit`, only from `branch-pushed`) and `POST /api/proposals/:id/reject`.
- **P19** — `detectOverlaps` groups open PRs by `targetPath`, records normalized pairs in
  `pr_crosslinks`, and enqueues `crosslink_pull_requests` so the watcher posts a
  cross-reference comment on each overlapping PR (each using its own destination token).

## HTTP endpoints

Mounted at `/api/proposals`. Mutating routes require `manage:knowledge`;
`verify-closure` requires `manage:jobs`; reads require `read:knowledge`.

- `GET /` (list, `?status=`, `?limit=` default 50, flow-scoped), `GET /:id`.
- `POST /from-gap`, `POST /from-gaps` (draft, 202 with job links).
- `POST /bulk` (`ready | publish | merge | reject` across ≤100 ids; always 200 with
  per-id results).
- `POST /:id/status`, `POST /:id/merge`, `POST /:id/reject`, `POST /:id/publish`,
  `POST /:id/verify-closure` (503 on incomplete/aborted re-ask), `GET /:id/execution-context`.
- There is **no** `/:id/regenerate` endpoint — regeneration is internal-only (P13).

## Key constants

| Constant | Default | Where |
| --- | --- | --- |
| `REGENERATION_CAP` | 3 | `apps/api/src/features/proposals/service.ts` |
| Branch name | `magpie/proposal-<id8>-<slug40>` | `apps/watcher/src/runners/publication.ts` |
| PR/commit title | `docs: <title>` | `apps/watcher/src/runners/publication.ts` |
| `GIT_TIMEOUT_MS` | 120000 | `packages/git/src/index.ts` |
| `GITHUB_API_TIMEOUT_MS` | 30000 | `packages/git/src/index.ts` |
| `MAGPIE_CHECKOUT_ROOT` | `.magpie/checkouts` | `apps/watcher/src/runners/publication.ts` |
| bulk `ids` cap | 100 | `apps/api/src/features/proposals/schema.ts` |

## Code map

| Concern | Code |
| --- | --- |
| Proposal statuses & type | `packages/core/src/index.ts` (`PROPOSAL_STATUSES`, `Proposal`) |
| Proposal service (draft/publish/merge/regen) | `apps/api/src/features/proposals/service.ts`, `routes.ts` |
| Proposal store | `apps/api/src/stores/{proposal-store,postgres-proposal-store}.ts` |
| Provenance fold | `apps/api/src/features/proposals/provenance.ts` |
| Git publishing (all in one module) | `packages/git/src/index.ts` (`LocalGitProposalPublisher`, `raisePullRequest`, mergeability, review decision) |
| Watcher publication runner | `apps/watcher/src/runners/publication.ts`, `refresh-flow-snapshot.ts` |
| PR transitions & crosslink | `apps/api/src/scheduling/gap-reconciler.ts` (`applyPullRequestTransition`, `detectOverlaps`), `apps/api/src/stores/postgres-pr-crosslink-store.ts` |
| Job contracts | `packages/jobs/src/{schemas,catalog}.ts` (`publish_proposal`, `draft_markdown_proposal`) |

## Tests (behavioural contract)

`apps/api/src/features/proposals/{service,closure-eval,link-cluster,provenance,regeneration,register-check,routes.bulk,routes.flow-scope,routes.merge-guard,routes.merge-idempotency,routes.merge,routes.validation}.test.ts`,
`apps/api/src/stores/{postgres-proposal-store,proposal-store,proposal-path,pr-crosslink-store}.test.ts`,
`packages/git/src/{publisher,publisher-concurrency,proposal-merge,comment,mergeability,review-decision}.test.ts`,
`apps/watcher/src/runners/{publication,publication-comment,publication-crosslink,refresh-flow-snapshot}.test.ts`.

## Provenance (design history)

Consolidates: `docs/superpowers/specs/2026-07-08-claim-provenance-design.md`,
`2026-07-03-local-git-proposal-merge-design.md`,
`2026-07-03-local-git-publish-and-watcher-coverage-banner-design.md`,
`2026-07-06-stale-pr-auto-regenerate-design.md`,
`2026-06-24-approval-state-tracking-design.md`,
`2026-07-16-reject-proposal-before-publish-design.md`,
`2026-07-14-bulk-proposal-actions-design.md`,
`2026-06-23-overlap-detection-crosslink-design.md`,
`2026-07-06-primary-branch-resolution-design.md`.

> **Drift found while writing (worth fixing in code/comments):** ① the `git` package's
> publishing code is a single `packages/git/src/index.ts`, not the
> `publisher.ts`/`proposal-merge.ts`/`comment.ts` some docs imply; ② the API service
> comment claiming it exports the branch-name/PR-body helpers is stale — those live only
> in the watcher's `publication.ts`; ③ migration `0028_proposal_review_decision.sql`'s
> comment references the old `refresh_pull_requests` job (now `refresh_flow_snapshot`).
