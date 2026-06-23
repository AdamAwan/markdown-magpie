# Approval-State Tracking — Design

**Date:** 2026-06-24
**Status:** Design (forks locked in brainstorming; ready for plan)
**Increment of:** the KB-maintenance reconcile redesign (`docs/maintenance-redesign.md`)

## Problem

The reconcile gate decides whether an incoming change should `open-new`, `fold`
into an open PR, or `defer` behind one. Now that the at-draft fold step
(`apps/api/src/scheduling/fold.ts`, shipped in #23) **actively rewrites** an
overlapping open PR's markdown, the gate's only safeguard against clobbering a
PR a human has already reviewed is the `touchable` flag on each
`OpenPullRequestSummary`.

That flag is currently hard-coded `true`
(`apps/api/src/scheduling/reconcile-gate.ts`, `openPullRequestSummaries`):

```ts
out.push({ proposalId: proposal.id, targets: [proposal.targetPath], touchable: true });
```

So a fold can silently rewrite a PR that a reviewer has already approved,
invalidating their review. The spine always intended `touchable` to mean
"open **and** un-approved". This increment makes that real.

The gate's decision logic (`decideReconciliation`) already does the right thing
once `touchable` is accurate: when every overlapping PR is non-touchable it
returns `defer` instead of `fold`. **No change to `decideReconciliation` is
needed** — only the input that feeds it.

## Goal

A proposal carries a tracked review decision derived from its GitHub PR. The
gate treats an approved PR as non-touchable, so fold never rewrites an approved
PR. When the only overlap is with an approved PR, the freshly-drafted rival is
published as its own PR instead.

## The data chain

```
watcher: derive review decision from GitHub
  → refresh_pull_requests output gains `reviewDecision` per result
    → API completeJob → handleRefreshPullRequestsCompletion
      → persist onto Proposal.reviewDecision (+ snapshot)
        → openPullRequestSummaries: touchable = reviewDecision !== "approved"
          → decideReconciliation returns `defer` for an approved overlap
            → reconcileDraftedProposal publishes the rival as its own PR
```

Each leg is detailed below.

## The review-decision value

A new normalised type in `packages/core/src/index.ts`, exported and reused by the
zod schema, the stores, and the gate:

```ts
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none";
```

This is the watcher's normalised reading of GitHub's review state — not a raw
mirror of GitHub's enum. Only `"approved"` locks a PR; every other value (and
the absence of a value) leaves it touchable. Storing the richer value rather
than a bare boolean keeps the snapshot inspectable and leaves room for future
lenses to treat `changes_requested` differently.

`Proposal` gains an optional field:

```ts
export interface Proposal {
  // ...
  reviewDecision?: ReviewDecision;
}
```

Optional because: a proposal that has never reached an open PR has no review
decision, and proposals drafted before this migration have none.

## Leg 1 — Watcher derives the review decision (`@magpie/git`)

A new exported helper in `packages/git/src/index.ts`, alongside
`fetchPullRequestStatus`:

```ts
export async function fetchPullRequestReviewDecision(
  pullRequestUrl: string | undefined
): Promise<ReviewDecision | undefined>;
```

Returns `undefined` in the same skip cases as `fetchPullRequestStatus` (not a
GitHub PR URL, no `GITHUB_TOKEN`, PR gone) so the runner can treat "couldn't
determine" uniformly. Reuses the existing `githubFetch` (abort-timeout) helper,
`parseGitHubPullRequestUrl`, and the `GITHUB_TOKEN` env var.

**Primary: GraphQL `reviewDecision`.** A `POST https://api.github.com/graphql`
querying `repository.pullRequest.reviewDecision`. GitHub computes this against
the repo's review policy (required reviewers, CODEOWNERS, branch protection),
so it is the authoritative "is this PR approved per policy" signal. Map:

| GitHub `reviewDecision` | our `ReviewDecision` |
| --- | --- |
| `APPROVED` | `approved` |
| `CHANGES_REQUESTED` | `changes_requested` |
| `REVIEW_REQUIRED` | `review_required` |
| `null` | → REST fallback |

**Fallback: REST reviews list.** When GraphQL returns `null` (the repo requires
no reviews, so GitHub has no policy verdict), fetch
`GET /repos/{o}/{r}/pulls/{n}/reviews` and reduce it to the **latest meaningful
review per author** (oldest-first list; keep the last `APPROVED` /
`CHANGES_REQUESTED` / `DISMISSED` per login, ignoring `COMMENTED` / `PENDING`; a
`DISMISSED` clears that author). Then:

- any author's latest is `CHANGES_REQUESTED` → `changes_requested`
- else any author's latest is `APPROVED` → `approved`
- else → `none`

i.e. "any human approval with no outstanding change request counts as
approved". This is the rule the brainstorming locked.

The helper is injected into the runner (see Leg 2) exactly like
`fetchPullRequestStatus`, so the watcher tests stay offline. The live GraphQL /
REST paths are exercised by `@magpie/git` unit tests that stub `globalThis.fetch`
(the pattern in `packages/git/src/comment.test.ts`).

## Leg 2 — Carry it through `refresh_pull_requests`

**Schema** (`packages/jobs/src/schemas.ts`): the result object gains an optional
`reviewDecision`:

```ts
export const refreshPullRequestsOutputSchema = z.object({
  results: z.array(z.object({
    proposalId: z.string(),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    reviewDecision: z.enum(["approved", "changes_requested", "review_required", "none"]).optional()
  }))
});
```

Optional, not required, for the conservative-update rule below.

**Runner** (`apps/watcher/src/runners/refresh-pull-requests.ts`): a second
injected dependency `fetchPullRequestReviewDecision` (defaulting to the real
helper, mirroring `fetchPullRequestStatus`). For each open PR, after fetching
status: **only when the PR is still open** (`status.state === "open"` and not
merged) fetch its review decision and attach it to the result. A merged/closing
PR's review decision is moot — the proposal is transitioning to merged/rejected
this same run, so skip the extra call. A review-decision lookup that throws or
returns `undefined` does **not** drop the PR from `results`; the PR is still
reported with its state, just without a `reviewDecision`.

## Leg 3 — Persist (`apps/api`)

**Store** (`apps/api/src/stores/proposal-store.ts` + `postgres-proposal-store.ts`):
a new method on `ProposalStore`:

```ts
updateReviewDecision(id: string, reviewDecision: ReviewDecision): Promise<Proposal | undefined>;
```

- In-memory: spread-update the record.
- Postgres: `UPDATE proposals SET review_decision = $2 WHERE id = $1 RETURNING *`;
  add `review_decision` to `ProposalRow` and `mapRow` (`row.review_decision ?? undefined`).
  `create()` is left unchanged — a fresh draft has no review decision, and the
  column is nullable.

**Migration** `packages/db/migrations/0028_proposal_review_decision.sql`:

```sql
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS review_decision text;
```

(Latest existing migration is `0027_pr_crosslinks.sql`.)

**Completion handler** (`handleRefreshPullRequestsCompletion` in
`apps/api/src/features/jobs/service.ts`): after the existing
`applyPullRequestTransition`, persist the review decision **only when the result
carries one**:

```ts
if (result.reviewDecision) {
  await ctx.stores.proposals.updateReviewDecision(result.proposalId, result.reviewDecision);
}
```

This is the **conservative-update rule**: a transient GraphQL/REST hiccup (which
yields a result with no `reviewDecision`) must never clobber a previously-known
`approved` back to a touchable value — that would re-open an approved PR to
folding, the exact failure we are preventing. Only a genuine fresh reading
updates the stored decision. A real change (approval dismissed → `review_required`)
*is* a fresh reading and does update.

**Snapshot** (`apps/api/src/stores/snapshot-store.ts` +
`apps/api/src/features/snapshots/service.ts`): `SnapshotPullRequest` and the
service's `PullRequestReading` gain an optional `reviewDecision`, threaded
through `refreshSnapshot` / `recordSnapshotsFromPullRequestResults` so the
`/snapshots` page shows it. This leg is for inspectability; the gate reads the
proposal, not the snapshot.

## Leg 4 — Gate consumes it

`openPullRequestSummaries` in `reconcile-gate.ts`:

```ts
out.push({
  proposalId: proposal.id,
  targets: [proposal.targetPath],
  touchable: proposal.reviewDecision !== "approved"
});
```

`decideReconciliation` is unchanged. Its existing test
"defers behind an overlapping non-touchable PR" already covers the resulting
behaviour; a new `openPullRequestSummaries` test asserts an `approved` proposal
yields `touchable: false` while the existing all-open-statuses test (no
`reviewDecision`) still yields `touchable: true`.

## Leg 5 — Defer behaviour (`fold.ts`)

`reconcileDraftedProposal` currently returns on any non-`fold` verdict. It gains
a `defer` branch that publishes the rival as its own PR — the same mechanism
`enqueueFoldFallback` uses:

```ts
if (decision.kind === "defer") {
  await ctx.stores.gapClusters.enqueuePublicationAction(rival.id, "publish");
  console.log(`Defer: rival ${rival.id} overlaps only approved PR(s); enqueued it to publish as its own PR.`);
  return;
}
if (decision.kind !== "fold") {
  return;
}
```

**Why this is a deliberate, safe action.** Nothing auto-publishes a fresh draft
today — a draft becomes a PR only via the merge/split publication outbox or a
human marking it "ready". So enqueuing a publish here is a new, intentional
behaviour, not a side effect of existing flow. It is safe because the #21
cross-link backstop (`detectOverlaps`) then detects the rival's PR overlapping
the approved PR and cross-links them, surfacing the overlap to the human who
owns the approved PR rather than silently rewriting their work. The spec states
this explicitly so reviewers understand the new publish is intended.

## Out of scope

- Changing `decideReconciliation` itself (already correct).
- Re-deriving review state inside the API (the API holds no GitHub token; the
  watcher is the only component that can read GitHub).
- Acting differently on `changes_requested` vs `review_required` (both are
  simply "touchable" for now; the richer value is stored for future use).
- The `triggeringQuestionIds`/`openPullRequests` draft-input schema-strip bug
  (tracked separately, same pattern as #22).
- Redesign steps 3–6 (route source-sync through the gate; fix-patrol;
  improve-patrol; retire `trigger_scheduled_crunch`).

## Testing strategy

- **`@magpie/git`**: unit tests stubbing `globalThis.fetch` — GraphQL `APPROVED`
  → `approved`; GraphQL `null` → REST fallback with each of the latest-per-author
  cases (approved, changes-requested-supersedes-approval, dismissed-clears,
  none); no token → `undefined`; non-PR URL → `undefined`.
- **`@magpie/jobs`**: `refreshPullRequestsOutputSchema` round-trips a result with
  and without `reviewDecision`.
- **watcher runner**: an open PR gets its review decision attached; a
  merged/closed PR does not trigger the review fetch; a review-fetch throw still
  reports the PR without a decision.
- **proposal store**: `updateReviewDecision` sets and returns the value
  (in-memory; postgres validated by typecheck).
- **completion handler**: a result with `reviewDecision` persists it; a result
  without one leaves a prior `approved` intact.
- **gate**: `openPullRequestSummaries` maps `approved` → `touchable: false`,
  everything else → `touchable: true`.
- **fold**: a drafted rival overlapping only an approved proposal enqueues its
  own publish (no fold job); overlapping a touchable proposal still folds.

## Global constraints (carried into the plan)

- UK English in all prose/comments.
- ESM: local imports use a `.js` suffix; `@magpie/*` imports do not.
- New job-output fields go on the zod schema **and** any core type it
  `satisfies` (this schema currently uses no `satisfies`, so the `ReviewDecision`
  enum is defined in core and mirrored literally in the zod `z.enum`).
- knip runs strict — every new export must have a consumer; no relaxing
  `knip.json`.
- The gate is `defer`-conservative: unknown approval state means touchable.
