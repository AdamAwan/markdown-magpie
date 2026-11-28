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
  worktree, and pushes. For a `github` destination it raises a PR, degrading to
  branch-only only when there is no PR to open (the remote is not GitHub, or no token
  resolves); a PR call that **fails** fails the job instead (P26). `local-git` skips the PR
  step. ⚠️ Corrected 2026-11: this clause used to say a failed PR call also degraded to
  branch-only — that swallowed the failure and stranded the proposal without a PR.
  The API stores whatever `branchName` the watcher returns — it does not derive branches
  itself.
- **P12** — Committer identity is required (`MAGPIE_GIT_AUTHOR_NAME` /
  `MAGPIE_GIT_AUTHOR_EMAIL`); the publisher throws if unset. Publishes are ordinary queued
  `publish_proposal` jobs — there is no separate "publications outbox" store; the reconcile
  gate re-publishes folded survivors through the same `enqueuePublishProposal` path.
- **P20** — **Every path a proposal writes or deletes MUST pass the destination
  document-path policy** (`checkDocumentPath`, `packages/git/src/document-path.ts`): a
  canonical relative posix path (no leading `/`, `~`, backslash, colon/drive letter, empty
  segment, control or invisible format character), with no `..`, no dot-segment
  (`.github`, `.git`, `./`, dot-files) and no `node_modules` segment, ending in `.md`
  (case-insensitive, matching the indexer), and lying under the destination's indexed
  subtree. Single-file targets are system-owned (`resolveProposalTargetPath`, or the
  indexed document path for correct/improve) and satisfy it by construction; multi-file
  changeset paths are **model-chosen**, so they are checked. A changeset entry is
  `{ path, content?, delete? }` — `path` is the only path-bearing field and is both the
  write and the delete target (a move is a delete + a write, both checked). Why: a
  prompt-injected document could otherwise steer a dedupe/split/fold at
  `.github/workflows/*`, `package.json`, or outside the subpath, and the branch is pushed
  and a PR opened automatically — where host CI may run it before any human reviews it
  ([threat-model.md#TM5](./threat-model.md)).
- **P21** — **The API rejects an unsafe model-chosen changeset when the job output is
  consumed, before any proposal is created or changed** (`rejectUnsafeChangeset`,
  `apps/api/src/scheduling/changeset.ts`). Per producer:
  - `dedupe_documents` — every path must also be the reviewed document or one of the
    neighbours the job was given;
  - `split_document` — new paths are allowed (they must still pass P20);
  - `fold_changeset_proposal` — every path must be in the union of the survivor's and the
    rival's file-sets; a rejected fold leaves the survivor untouched and falls back to
    publishing the rival as its own PR (the same fallback as a failed fold);
  - source-sync — writes are restricted to the offered candidate documents, re-keyed to the
    candidate's indexed path, and a candidate outside P20 is never written.

  A rejection is logged (`changeset rejected: …` with job id, type, path and reason) and
  the output is dropped like any other malformed completion: the job stays completed, no
  proposal is created, the dispatcher does not throw (so no 500/replay loop) and no paid
  generation is retried. The **watcher publication runner** re-checks the whole file-set
  before any checkout, and the **git publisher** checks it again against the destination
  subtree (`relativePathFromRoot`) before touching git, and refuses a target whose
  existing path passes through a symlink (writes and deletes) or whose parent's realpath
  leaves the subtree — so a bad path cannot reach the working tree even if an API check is
  missed. A publish refused there fails the `publish_proposal` job with a `Refusing to
  publish …` error; nothing is pushed.

## Crash, abort & retry robustness

A publish is an ordinary retried job, so every way an attempt can die — watcher killed
mid-git, job cancelled, GitHub briefly failing — MUST leave the destination checkout in a
state the next attempt can proceed from, and the next attempt MUST converge on the same
branch and PR rather than erroring or duplicating.

- **P22** — **A dead publish's worktree never blocks a retry.** Before `git worktree add`,
  under the checkout lock, the publisher runs `git worktree prune` (drops registrations
  whose directory is gone, e.g. tmp wiped by a container restart), then force-removes
  (`worktree remove --force --force`, falling back to deleting the directory) any linked
  worktree that still has **this proposal's branch** checked out, and prunes again. Why:
  a watcher killed between `worktree add` and its cleanup leaves the branch registered as
  checked out, and every retry otherwise fails with "'…' is already used by worktree".
  The main working tree and worktrees on other branches are never touched; a live
  publish of the same branch in this process cannot exist, because it would hold the
  lock (cross-process serialisation is out of scope, as for the checkout lock itself:
  two watchers publishing the same proposal on one shared volume are not supported). The
  publish's own cleanup always runs (even after an abort) and also prunes.
- **P23** — **Stale git lock files are cleared, live ones are not.** Under the checkout
  lock, before publishing (and before every sync, [IN42](./ingestion.md)), the top-level
  `index.lock`, `HEAD.lock`, `config.lock`, `packed-refs.lock` and `shallow.lock` of the
  checkout's git dir are deleted **only if older than 2 × `GIT_TIMEOUT_MS`**. In this
  process the lock already guarantees none of our git children is running on the
  checkout; the age bound covers a git started by another process sharing the volume —
  every git child of ours is killed at `GIT_TIMEOUT_MS`, so an older lock has no live
  owner. A younger lock is left alone: the operation fails as a transient lock error and
  the job's retry finds it released or aged out.
- **P24** — **The job's abort signal reaches every git and GitHub call.** Aborting (job
  cancelled by the server, watcher shutting down) kills the in-flight git child with
  SIGTERM — on which git removes its own lock files — rejects with an aborted
  `GitCommandError` that is never retried and never swallowed as "no output", and cancels
  an in-flight GitHub request. The temporary worktree is still removed.
- **P25** — **Republishing an already-pushed branch is idempotent.** When the remote
  branch exists and the document (or changeset) equals its tip, the publisher returns the
  tip without committing or pushing, and reports it as published (not `noChange`, which
  stays reserved for a fresh branch whose content already matches the base, P15). This is
  how the retry of an attempt whose push landed resolves. The remote-branch probe
  (`ls-remote`) fails the publish when the remote is unreachable rather than reading as
  "branch absent" and taking the create path.
- **P26** — **A PR failure after a successful push fails the job, and the retry reuses
  what exists.** For a `github` destination the runner throws (`Branch … was pushed but
  opening its pull request failed: …`, credential-redacted) so the queue retries the job;
  recording a branch-only publish would strand the proposal at `branch-pushed` with no
  PR and nothing that would ever open one. `raisePullRequest` first looks up an **open PR
  for the head branch** and reuses it, creating one only when none exists, and adopts the
  winner of a create race (422 "already exists"). A failed lookup throws rather than
  reporting "none" — guessing would risk a duplicate PR. Together with P25 a retry pushes
  nothing twice and opens at most one PR. When retries are exhausted the job fails
  terminally like any other publish failure and the proposal keeps its pre-publish
  status.

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
  `POST /:id/verify-closure` (`closureStatus: "pending"` while re-asks are outstanding),
  `GET /:id/execution-context`.
- There is **no** `/:id/regenerate` endpoint — regeneration is internal-only (P13).

## Key constants

| Constant | Default | Where |
| --- | --- | --- |
| `REGENERATION_CAP` | 3 | `apps/api/src/features/proposals/service.ts` |
| Branch name | `magpie/proposal-<id8>-<slug40>` | `apps/watcher/src/runners/publication.ts` |
| PR/commit title | `docs: <title>` | `apps/watcher/src/runners/publication.ts` |
| `GIT_TIMEOUT_MS` | 120000 | `packages/git/src/run-git.ts` |
| `GIT_CLONE_TIMEOUT_MS` | 1800000 | `packages/git/src/run-git.ts` |
| Stale git-lock age (P23) | 2 × `GIT_TIMEOUT_MS` | `packages/git/src/checkout-repair.ts` |
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
| Document-path policy (P20) | `packages/git/src/document-path.ts` (`checkDocumentPath`, `findUnsafeChangesetPath`) |
| Changeset path enforcement (P21) | `apps/api/src/scheduling/changeset.ts` (`rejectUnsafeChangeset`); callers `apps/api/src/features/proposals/service.ts` (dedupe/split), `apps/api/src/scheduling/fold.ts` (`applyChangesetFoldFromCompletedJob`), `apps/api/src/features/source-sync/service.ts` (`constrainToCandidates`); publish-time `apps/watcher/src/runners/publication.ts` (`assertPublishablePaths`), `packages/git/src/index.ts` (`resolveTargetPath`, `assertNoSymlinkOnPath`, `assertRealParentWithin`) |
| Crash/abort recovery (P22–P24) | `packages/git/src/checkout-repair.ts` (`releaseStaleBranchWorktrees`, `clearStaleGitLocks`), `packages/git/src/run-git.ts` (`git`, `GitCommandError`), `packages/git/src/index.ts` (`preparePublish`, `cleanupWorktree`) |
| Idempotent retry & PR failure (P25–P26) | `packages/git/src/index.ts` (`publishLocked`, `raisePullRequest`, `findOpenPullRequest`), `apps/watcher/src/runners/publication.ts` (`publishProposal`) |
| PR transitions & crosslink | `apps/api/src/scheduling/gap-reconciler.ts` (`applyPullRequestTransition`, `detectOverlaps`), `apps/api/src/stores/postgres-pr-crosslink-store.ts` |
| Job contracts | `packages/jobs/src/{schemas,catalog}.ts` (`publish_proposal`, `draft_markdown_proposal`) |

## Tests (behavioural contract)

`apps/api/src/features/proposals/{service,closure-eval,link-cluster,provenance,regeneration,register-check,routes.bulk,routes.flow-scope,routes.merge-guard,routes.merge-idempotency,routes.merge,routes.validation}.test.ts`,
`apps/api/src/stores/{postgres-proposal-store,proposal-store,proposal-path,pr-crosslink-store}.test.ts`,
`packages/git/src/{publisher,publisher-concurrency,proposal-merge,comment,mergeability,review-decision,document-path}.test.ts`,
`packages/git/src/{publisher-recovery,checkout-repair,run-git,raise-pull-request}.test.ts` (P22–P26),
`apps/api/src/scheduling/fold.test.ts`, `apps/api/src/features/source-sync/service.test.ts` (P21),
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
