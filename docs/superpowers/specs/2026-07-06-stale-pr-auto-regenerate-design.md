# Auto-regenerate stale proposal PRs

**Status:** Design — pending implementation plan
**Date:** 2026-07-06

## Problem

When Magpie publishes a proposal it cuts a branch from the current default-branch
tip, writes the proposal's `markdown` as a **full-file overwrite** of `targetPath`,
pushes, and opens a PR. The proposal moves to `branch-pushed` / `pr-opened` and
Magpie never looks at the branch again ([publication.ts](../../../apps/watcher/src/runners/publication.ts)).

If `main` advances and touches that same file before the PR merges, the PR becomes
non-mergeable. Today nothing detects or handles this — the PR sits conflicted
indefinitely. `mergeLocalProposalBranch` handles the *merge-time* conflict for
local-git destinations ([index.ts:1024](../../../packages/git/src/index.ts)), but there is
no handling for an **already-published hosted PR** going stale after the fact.

Because a single-file proposal is a whole-file write, a merge conflict can only mean
*that exact target file changed on main* since the branch was cut. A textual rebase
is therefore meaningless — the fix is to **regenerate the doc against the new base**
and re-push. This is the [[kb-describes-sources]] principle: the base moved, so the
correct content is a fresh draft, not a hand-merge.

## Decisions (locked)

- **Detection source:** trust GitHub's `mergeable_state` — no local dry-run merge.
- **Remediation:** **automatic** — a detected-stale proposal regenerates without a
  human trigger, and force-pushes so the existing PR updates in place.

## Why not a single "resolve conflicts" job

"Resolve" = regenerate (AI) + re-push (GitHub token). Those are two different job
**capabilities**, and the queue-only non-negotiable forbids one runner holding both
the GitHub token and calling the chat model inline. A monolithic resolver would have
to enqueue a generative job mid-run anyway — i.e. it *is* the fan-out below, just
hidden inside a runner. So the work decomposes into the existing patrol-lens shape:

```
detect stale (github) → regenerate draft (generative) → re-publish onto same branch (github)
```

Detection and re-publish already exist; only the middle step is a new job type.

## Architecture

### 1. Detect staleness — extend `refresh_flow_snapshot` (github)

`refresh_flow_snapshot` already lists every open PR and does one GitHub GET per PR
([refresh-flow-snapshot.ts](../../../apps/watcher/src/runners/refresh-flow-snapshot.ts)).
`mergeable_state` is returned on that **same** GET, so detection is one extra field —
no new GitHub calls, no new job, no doubled rate-limit pressure.

- Extend `fetchPullRequestStatus` in `@magpie/git` to also return `mergeable` /
  `mergeable_state`.
- Extend the runner's per-PR result and `refreshFlowSnapshotOutputSchema` with a
  `mergeable` signal (tri-state: `mergeable` / `conflicting` / `unknown`).
  `mergeable_state` is computed asynchronously by GitHub and is often `unknown` on
  the first read — treat `unknown` as "no signal this run", never as a trigger.
- The API's PR-transition handler (the `applyPullRequestTransition` path behind
  `refresh_flow_snapshot`'s output) consumes the new field.

### 2. API transition — enqueue regeneration

When the API sees a proposal flip to `conflicting`:

- **Guard: skip approved PRs.** Reuse the existing non-touchable rule — if
  `reviewDecision === "approved"`, do **not** regenerate (regeneration would rewrite
  content under a reviewer who already signed off). Surface it instead (see §5).
- **Guard: attempt cap.** Track a regeneration counter on the proposal; after N
  (default 2) failed regenerate→still-conflicting cycles, stop and surface for a
  human rather than loop forever.
- **Guard: in-flight.** Don't enqueue a second `regenerate_proposal` while one is
  pending for the same proposal (idempotent on proposalId).
- Otherwise enqueue `regenerate_proposal` with the proposal id.

### 3. New job — `regenerate_proposal` (generative)

A generative-capability job that re-drafts an existing proposal against current base.
Added via the `add-a-job-type` skill (contract in `@magpie/jobs`, runner in
`apps/watcher/src/runners`, capability gate, enqueue + output consumption).

- **Input:** `{ proposalId }`.
- **Context reconstruction:** the durable inputs are already persisted on the
  `Proposal` — `flowId`, `triggeringQuestionIds`, `targetPath`, `gapClusterId`,
  `evidence`, `draftContext`. The generative runner drafts by calling
  `api.retrieve(question, flowId, …)` live ([generative.ts:156](../../../apps/watcher/src/runners/generative.ts)),
  so context is **reconstructed at draft time against the new base** — not replayed
  from stale bytes. This is the same operation that produced the original draft.
- **Output:** fresh `markdown` (and `changeset` for multi-file proposals), written
  back to the proposal, then chained to re-publish.

### 4. Re-publish — reuse `publish_proposal` (github)

`publish_proposal` already pushes a branch. The only change: when publishing a
proposal that already has `publication.branchName`, **force-push onto the existing
branch** instead of creating a new one, so the open PR updates in place (PR URL,
crosslinks, and comment history all preserved). No new PR is opened.

- Add an input/branch-mode signal so the publisher force-pushes the existing branch.
- After a successful re-push the proposal returns to `pr-opened`; the next
  `refresh_flow_snapshot` re-reads `mergeable_state` and confirms it now merges.

### 5. Fallback — surface for a human

Regeneration handles the common case (source moved → redraft). It cannot fix
structural conflicts (e.g. the destination's docs folder itself moved, or the target
path was deleted on main), and it must not loop. When the attempt cap is hit, or the
PR is `approved`, mark the proposal with a `stale`/`needs-attention` signal that the
console surfaces so a human resolves it on GitHub. (Exact console treatment is a
follow-up UI increment, not blocking for the pipeline.)

## Data-flow summary

```
refresh_flow_snapshot (github, ~5m)
  └─ per open PR: fetch status + mergeable_state
        └─ API applyPullRequestTransition
              ├─ mergeable        → no-op
              ├─ unknown          → no-op (no signal)
              └─ conflicting
                    ├─ approved / cap hit → surface for human (§5)
                    └─ else → enqueue regenerate_proposal (generative)
                                └─ re-retrieve + re-draft against new base
                                      └─ enqueue publish_proposal (force-push existing branch)
                                            └─ PR updates in place → next poll confirms mergeable
```

## Components & boundaries

| Unit | Capability | Responsibility | New? |
|---|---|---|---|
| `fetchPullRequestStatus` | — (git lib) | expose `mergeable_state` | extend |
| `refresh_flow_snapshot` runner | github | report per-PR mergeability | extend |
| API PR-transition handler | — | conflicting → enqueue regenerate, with guards | extend |
| `regenerate_proposal` job + runner | generative | re-draft existing proposal against new base | **new** |
| `publish_proposal` runner | github | force-push onto existing branch | small tweak |
| Proposal model | — | regeneration counter; stale/needs-attention signal | extend |

## Error handling

- **`unknown` mergeable state:** never a trigger. Only an explicit `conflicting`
  signal enqueues regeneration.
- **Regenerate job fails:** proposal left at `pr-opened` (conflicted) unchanged; the
  next poll re-detects and retries until the attempt cap.
- **Re-push fails:** proposal left conflicted; retried on next detection, subject to
  the same cap. Never advance proposal state on a failed push.
- **Approved PR:** never auto-regenerated — always surfaced.
- **Idempotency:** at most one in-flight `regenerate_proposal` per proposal.

## Testing

- **Unit — detection:** `refresh_flow_snapshot` maps `mergeable_state` values
  (`clean`/`dirty`/`unknown`/`blocked`) to the tri-state signal; `unknown` yields no
  trigger. Offline via injected `fetchPullRequestStatus`.
- **Unit — transition guards:** conflicting + un-approved + under cap → enqueues;
  approved → surfaces, not enqueues; at cap → surfaces; in-flight → no duplicate.
- **Unit — regenerate runner:** given a proposal id, re-retrieves via a fake
  `api.retrieve` and produces fresh markdown; deterministic provider fixture.
- **Unit — re-publish:** existing `publication.branchName` → force-push path (no new
  PR); branchless → create path (unchanged).
- **Integration (RUN_PG_INTEGRATION):** proposal store persists + reads the
  regeneration counter and stale signal.
- Follow `writing-magpie-tests` conventions throughout.

## Out of scope / follow-ups

- Local-git (`file://`) staleness detection (no GitHub `mergeable_state`) — would
  need a checkout dry-run merge; deferred. This spec is hosted-only.
- Console UI for the surfaced/`needs-attention` state — a later UI increment.
- Force-push safety when a human has pushed hand-edits to the proposal branch —
  worth considering as a guard (detect divergence and surface instead of clobbering).
