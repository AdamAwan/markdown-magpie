# First-class local-git flow mode (Accept / Bin, no GitHub ceremony)

**Date:** 2026-07-06
**Status:** Approved (Adam)

## Problem

When a flow's destination is a local (`file://`) git repository, the system still
behaves as if it were publishing to GitHub:

1. **Publishing routes to `github`.** The local/GitHub decision is made per-proposal
   by [`isLocalGitDestination`](../../../apps/api/src/features/proposals/service.ts),
   which is `isFileUrl(destination.url)`. Two detection holes make that return
   `false` for a genuine `file://` destination:
   - The config normalizer's `isGitUrl`
     ([`knowledge-repositories.ts`](../../../apps/api/src/stores/knowledge-repositories.ts))
     does not recognize `file://`, so a `file://` destination written as a bare
     string or a `path:` normalizes to `kind:"local"` with `url` **undefined** →
     `isFileUrl(undefined)` is false → routes to `github`.
   - [`selectDestinationForProposal`](../../../apps/api/src/platform/repositories.ts)
     returns `undefined` when there are multiple destinations and a proposal has no
     explicit `destinationId` and no subpath match → again false → `github`.

2. **GitHub-shaped scheduled work is offered per flow regardless of destination.**
   The scheduled task templates
   ([`task-registry.ts`](../../../apps/api/src/scheduling/task-registry.ts)) expand
   over every flow. `snapshot-refresh` (`refresh_flow_snapshot`, the PR poller,
   `github` capability) is offered even for a flow whose destination is local and
   has no pull requests to poll.

3. **The proposal UI is GitHub-shaped.** A local proposal is a two-step "Publish
   Branch" then "Merge"/"Mark Merged", surfacing PR fields that never apply.

The desired model for a local-git flow: gap → draft → (auto-fold with overlaps) →
**auto-publish a review branch** → human clicks **Accept** (merge) or **Bin**
(reject). No PR, no PR-polling, no crosslink, no "Mark Merged".

## Goals

- A `file://` destination is detected as local-git no matter how it is written in
  config (bare string, `path:`, or `url:`).
- One predicate — the flow's publish mode — drives publish routing, scheduled-task
  gating, and the proposal UI. No per-site sniffing.
- A local-git flow never offers or enqueues GitHub-only work.
- The proposal review UI for a local flow is exactly **Accept** / **Bin**.
- No behaviour change for GitHub flows.
- A token-less watcher (`maintenance` + `local-git` capabilities) runs a local flow
  end-to-end.

## Non-goals

- The hosted "Mark Merged" redundancy tidy-up (separate future task).
- Any change to GitHub publish/merge/PR-poll behaviour.
- A rejected-content "fingerprint" suppression beyond the cluster freeze (the freeze
  already prevents the immediate re-draft loop; a richer suppression is a follow-up).
- Rotating the committed `GITHUB_TOKEN` (flagged separately; operational, not code).

## Design

### 1. Detection fix (root cause)

In [`knowledge-repositories.ts`](../../../apps/api/src/stores/knowledge-repositories.ts):

- Extend `isGitUrl` to treat a `file://` URL as a git URL.
- In `normalizeRepositoryObject`, derive `url` from a `file://` value found in any of
  `value` / `url` / `path` / `localPath`, so all of these normalize to
  `kind:"git"` with `url` set:
  - `{"id":"demo","url":"file:///c/repo"}`
  - `{"id":"demo","path":"file:///c/repo"}`
  - `"file:///c/repo"` (bare string)

  A plain local **directory** path (not a `file://` URL) still normalizes to
  `kind:"local"` and remains a non-publishable index-only destination — local-git is
  specifically "a git repo reachable via `file://`". `isFileUrl` (via `new URL`)
  handles the Windows `file:///C:/…` form.

Harden [`selectDestinationForProposal`](../../../apps/api/src/platform/repositories.ts):
when a proposal has no `destinationId`, resolve the destination through the
proposal's **flow** (`flow.destinationId`) before the existing subpath / single
fallback. Flow-drafted proposals already carry a `destinationId`, but this closes
the "unresolved → github" gap for any proposal that knows only its flow.

### 2. Flow-mode predicate (single source of truth)

Add `flowPublishMode(ctx, flowId): "local-git" | "github"`, derived from the flow's
resolved destination (`isFileUrl(destination.url) ? "local-git" : "github"`).

`isLocalGitDestination(ctx, proposal)` is re-expressed on top of the same resolution
(destination via `destinationId` → flow → subpath), so proposal-level and flow-level
checks can never disagree. `enqueuePublishProposal`'s call site is unchanged.

### 3. Scheduled-task gating

Add a `githubOnly: boolean` marker to `FlowTaskTemplate`
([`task-registry.ts`](../../../apps/api/src/scheduling/task-registry.ts)).
`snapshot-refresh` is marked `githubOnly`. `listScheduledTasks` skips `githubOnly`
templates for a flow whose `flowPublishMode` is `local-git`. All other templates
(reconcile/draft/publish `process_gaps_to_pull_requests` — `maintenance` capability;
`source-change-sync`; the patrols) expand for both modes.

`crosslink_pull_requests` / `comment_pull_request` need no change: they are only
enqueued for `pr-opened` overlaps, which a local flow never reaches
([`detectOverlaps`](../../../apps/api/src/scheduling/gap-reconciler.ts)).

### 4. Lifecycle: auto-publish → review → Accept / Bin

- **Auto-publish already exists.** The reconcile publication outbox publishes a
  ready local proposal to `branch-pushed` (push only, no PR — already correct in
  [`publication.ts`](../../../apps/watcher/src/runners/publication.ts)). `branch-pushed`
  is the "in review" state for a local flow.
- **Accept** = the existing `POST /proposals/:id/merge`
  ([`mergeLocalProposal`](../../../apps/api/src/features/proposals/service.ts)) →
  `merged` + merge cascade. Relabelled "Accept" in the UI; no behaviour change.
- **Bin** = new `POST /proposals/:id/reject`, local-git only, mirroring the GitHub
  close-without-merge transition
  ([`applyPullRequestTransition`](../../../apps/api/src/scheduling/gap-reconciler.ts)):
  1. `status → rejected`
  2. freeze the proposal's gap cluster (prevents re-draft; no gap reopening)
  3. delete the pushed review branch (local analog of closing the PR)

  New `deleteLocalProposalBranch({ repoPath, branchName, defaultBranch })` in
  `@magpie/git` (inline, symmetric with `mergeLocalProposalBranch`): checkout the
  default branch, `git branch -D <branchName>`, under the checkout lock. Guarded to
  reject a non-local-git or non-rejectable proposal (mirrors `mergeLocalProposal`).

  The cluster-freeze step reuses the same store call
  `freezeCluster(clusterId)` that `freezeClusterForProposal` uses; that helper is
  exported (or a thin shared equivalent added) so the reject path and the PR-poll
  path share one freeze implementation.

### 5. UI ([`ProposalsPanel`](../../../apps/web/src/components/ProposalsPanel.tsx))

For a proposal whose `localGitDestination` is true:

- Remove "Publish Branch" (auto-published), "Mark Merged", and PR fields
  (`pullRequestUrl`, "Published"/PR metadata) from the local branch.
- In the `branch-pushed` (review) state show two actions: **Accept**
  (`mergeProposal`) and **Bin** (new `rejectProposal`).

GitHub proposals are unchanged (Publish Branch, Mark Merged, PR flow).
`ConsoleProvider` gains `rejectProposal(proposalId)` → `POST /proposals/:id/reject`.

### 6. Watcher / capabilities

No changes. Local-git publish already skips the PR step; Accept and Bin are inline
API git operations (like merge). A watcher advertising `maintenance` + `local-git`
runs a local flow end-to-end with no `GITHUB_TOKEN`.

## Data flow

```
config: file:// (string | path | url)  → normalizer → kind:"git", url:file://
flow    → flowPublishMode → local-git | github
enqueue: proposal → isLocalGitDestination → publish_proposal{destination}
         → queue publish_proposal__local_git   (push branch, no PR)
schedule: listScheduledTasks skips githubOnly templates for local-git flows
review:  branch-pushed → Accept (merge+cascade) | Bin (rejected+freeze+delete branch)
```

## Testing

- **knowledge-repositories.test**: `file://` as bare string / `path:` / `url:` all
  normalize to `kind:"git"` with `url` set; a plain directory path stays `kind:"local"`.
- **repositories / proposals service**: `flowPublishMode` returns `local-git` for a
  `file://` flow and `github` otherwise; `selectDestinationForProposal` resolves via
  flow when `destinationId` is absent; `isLocalGitDestination` agrees with
  `flowPublishMode`.
- **task-registry.test**: a local-git flow omits `snapshot-refresh`; a github flow
  keeps it; non-`githubOnly` templates expand for both.
- **proposals reject**: `POST /:id/reject` on a branch-pushed local proposal →
  `rejected`, cluster frozen, branch deleted; 409 for a github destination; 409 for a
  non-rejectable status. `@magpie/git` `deleteLocalProposalBranch` unit test.
- **web/console.test**: local proposal renders Accept/Bin and no Publish/Mark
  Merged/PR fields; github proposal unchanged.

## Docs

- `docs/ai-jobs.md`: note `refresh_flow_snapshot` is github-only and not scheduled
  for local-git flows.
- `docs/architecture.md`: the local-git flow lifecycle (auto-publish → review →
  Accept/Bin).
- `magpie-orientation` skill: mention the flow publish-mode predicate.

## Rollout / compat

Additive. GitHub flows are untouched. Existing correctly-configured `file://`
destinations (full `{url, kind:"git"}` form) keep working and additionally gain the
Accept/Bin UI and task-gating. Previously-misconfigured bare-string/`path` `file://`
destinations start being detected as local-git.

## Open follow-ups

- Hosted "Mark Merged" redundancy tidy-up.
- Richer rejected-content suppression beyond cluster freeze (avoid re-proposing a
  human-rejected doc even after the cluster is unfrozen).
- Rotate the committed `GITHUB_TOKEN`.
