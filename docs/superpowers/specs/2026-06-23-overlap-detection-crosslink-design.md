# Overlap detection + PR cross-linking — design

**Status:** Approved (brainstormed 2026-06-23) · **Author:** Adam

The first live-integration increment of the maintenance redesign
([`docs/maintenance-redesign.md`](../../maintenance-redesign.md)), building on the merged
reconcile spine ([`2026-06-23-maintenance-redesign-spine.md`](../plans/2026-06-23-maintenance-redesign-spine.md)).

## Goal

Wire the spine into the live reconciler in **observe-first** mode: when two open pull
requests in a flow touch the same knowledge-base file, surface that overlap as a
reviewer-visible cross-link comment on both PRs. **Nothing is suppressed, folded, or
deferred** — both PRs open exactly as today. This lets us watch real overlaps before letting
the gate *act* on them (folding is the next increment).

### Decisions locked during brainstorming

- **Increment scope:** detect + hold (observe first), not fold.
- **Hold mechanics:** both PRs continue to exist; they are cross-linked, not merged.
- **Cross-link surface:** the GitHub PRs themselves (reviewer-visible), via a comment.

## Scope

**In:** overlap detection across a flow's open PRs; a GitHub comment on each PR of an
overlapping pair; idempotency so a pair is linked once, not every tick.

**Out (later increments):** the LLM fold; acting on `decideReconciliation`'s
`fold`/`defer` verdicts; approval/touchability tracking; routing source-sync and the patrols
through the gate; retiring crunch.

**Spine usage:** this increment exercises **`sharedTargets`** (file-set overlap). The full
**`decideReconciliation`** gate is consumed in the *fold* increment, where its verdict drives
action — here there is no action to drive, only detection.

## Architecture

Five units, each with one responsibility, composing left to right:

```
reconciler tick ──► detectOverlaps (API) ──► crosslink_pull_requests job ──► PublicationRunner (watcher) ──► GitHub comments
                          │                          ▲
                          └──► prCrosslinks store ────┘  (idempotency: a pair is linked once)
```

### 1. `detectOverlaps(ctx, flowId)` — API, new pass in the reconciler

Runs each tick inside `reconcileGaps` (`apps/api/src/scheduling/gap-reconciler.ts`),
immediately after the existing `refreshOpenPullRequests` pass.

- List this flow's open proposals with a real `pullRequestUrl` (status `pr-opened`,
  `publication.pullRequestUrl` set). Branch-only publishes are skipped — there is no PR to
  comment on.
- Filter to this flow with the existing `proposalFlowId` / `sameFlow` helpers.
- For each unordered pair, compute `sharedTargets([a.targetPath], [b.targetPath])`. (Today a
  proposal has a single `targetPath`; the helper already takes arrays, so this generalises for
  free when proposals gain multi-file sets.)
- For each overlapping pair **not already in `prCrosslinks`**, record the pair (see §4) and
  enqueue one `crosslink_pull_requests` job carrying both PRs.

Pure-ish and store-driven, so it unit-tests offline with the existing `makeTestContext`
harness, exactly like the other reconciler passes. Failures are logged and never abort the
rest of `reconcileGaps` (same best-effort posture as `refreshOpenPullRequests`).

### 2. `crosslink_pull_requests` job — `@magpie/jobs`

A new `github`-capability job type (alongside `publish_proposal`).

- **Input:** the flow plus the pair — each side's `proposalId`, `pullRequestUrl`, and shared
  `targets` (so the comment can name the file). Plus the PR `number`/`url` needed to comment.
- **Output:** which PRs were commented on and when.
- Expiry 10 min, mirroring the other github jobs.

### 3. PublicationRunner handles it — `apps/watcher`

`apps/watcher/src/runners/publication.ts` already owns `github` jobs. Add
`crosslink_pull_requests` to `PUBLISH_JOB_TYPES`, dispatch it in `run()`, and implement a
private method that posts a comment on each PR via a new dep. The dep
(`commentOnPullRequest`) is added to `PublicationDeps` and wired in
`createGitPublicationDeps`.

Comment body, e.g.:

> 🔗 **Magpie:** this PR overlaps [#18](…) — both edit `kb/billing/refunds.md`. They may be
> consolidated. _(automated overlap detection)_

### 4. `commentOnPullRequest` — `@magpie/git`

A new exported helper mirroring `raisePullRequest`: parse the GitHub slug from the PR/remote
URL, `POST` to `…/issues/{number}/comments` (GitHub treats PR comments as issue comments)
using the existing `githubFetch` + `GITHUB_TOKEN` pattern. Returns the created comment URL, or
`undefined` when there is no token/slug (degrades quietly, like `raisePullRequest`).

### 5. `prCrosslinks` store + migration — idempotency

A small dedicated store (mirroring `reconciliation-decision-store.ts`: interface + in-memory +
postgres + factory + `AppContext` wiring) backed by migration `0027_pr_crosslinks.sql`:

```
pr_crosslinks(
  id, flow_id,
  proposal_low text, proposal_high text,   -- the pair, normalised so (a,b)==(b,a)
  targets text[],                            -- the shared files, for audit
  linked_at timestamptz
)
UNIQUE (proposal_low, proposal_high)
```

Methods: `has(a, b)`, `record({flowId, a, b, targets})` (normalises the pair), `list(limit)`,
`reset()`. The pair is recorded **at enqueue time**; `detectOverlaps` skips any pair already
present.

A dedicated table (rather than reusing `reconciliation_decisions`) keeps idempotency correct —
a `UNIQUE` pair constraint is the natural "linked once" guarantee, and it avoids overloading
`cluster_ids` with proposal ids.

## Data flow

1. Tick → `reconcileGaps` → `refreshOpenPullRequests` (unchanged) → `detectOverlaps`.
2. `detectOverlaps` finds an unlinked overlapping pair → `prCrosslinks.record(pair)` →
   enqueue `crosslink_pull_requests`.
3. Watcher's `PublicationRunner` runs the job → `commentOnPullRequest` on each side.
4. Next tick: the pair is in `prCrosslinks`, so it is skipped — no duplicate comments.

## Error handling & trade-offs

- **Best-effort, like the rest of the reconciler:** a detection or enqueue error is logged and
  swallowed; `reconcileGaps` continues.
- **No auto-retry on comment failure (deliberate observe-first simplification):** the pair is
  recorded at enqueue, so a failed comment job is not retried. A failed *cross-link comment* is
  low-stakes (it is advisory), and retry/repair belongs with the fold increment that makes
  cross-links actionable. The job failure is still visible in the job log.
- **Token-less environments:** `commentOnPullRequest` returns `undefined` (no throw), matching
  `raisePullRequest`; the job completes as a no-op.

## Testing

- **API:** `detectOverlaps` with the in-memory harness — overlap found enqueues one job and
  records the pair; non-overlapping pairs do nothing; already-linked pairs are skipped;
  branch-only (no `pullRequestUrl`) proposals are skipped; cross-flow proposals are ignored.
- **Store:** `prCrosslinks` pair normalisation (`has(a,b) === has(b,a)`) and dedup.
- **Watcher:** `crosslink_pull_requests` runner with a fake `commentOnPullRequest` asserting it
  is called once per side with the expected body; token-less path is a no-op.
- **Migration:** the new table + unique constraint applies cleanly.
- **Gate:** root `npm run typecheck` and `npm run deadcode` (knip strict) stay green.

## Out-of-scope follow-ups (named, not built here)

The fold increment: consume `decideReconciliation`'s `fold` verdict to LLM-re-draft an open PR
that absorbs an overlapping change; add approval tracking so `defer` fires; then the patrols.
