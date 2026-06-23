# Link autonomous drafts to their gap cluster — design

**Status:** Approved (brainstormed 2026-06-23) · **Author:** Adam

A prerequisite fix for the fold-at-draft increment, and an independent bug fix in its own
right. Part of the knowledge-base maintenance redesign
([`docs/maintenance-redesign.md`](../../maintenance-redesign.md)).

## The bug

On the autonomous gap→PR path, a drafted proposal is **never linked to its gap cluster**:

- `createProposalFromCompletedJob` (`apps/api/src/features/proposals/service.ts`) creates the
  proposal without a `gapClusterId`.
- `linkCluster` is only ever called by the boot-time backfill (`gap-backfill.ts`).

Consequences:

1. **Duplicate PRs.** `draftProposalsForUncoveredClusters` treats a cluster as covered only
   when some proposal carries its `gapClusterId`. An autonomous draft never sets it, so the
   next gap-revision bump re-drafts the same cluster → a second proposal/PR for work already in
   flight. (It is masked today only because drafting is gated behind revision bumps, so it
   doesn't fire every tick.)
2. **Reshape can't find these proposals.** `proposalForCluster` (used by `applyMerge`/
   `applySplit`) matches on `gapClusterId`, so it misses autonomously-drafted proposals.

This link is also the foundation the fold increment needs (to absorb a rival cluster into a
survivor).

## Why a passthrough doesn't work (mechanism note)

The job broker stores `inputSchema.safeParse(input).data` (`apps/api/src/jobs/fake-broker.ts`),
and `draftMarkdownProposalInputSchema` is a plain `z.object`, which **strips keys it doesn't
declare**. So adding `gapClusterId` only to the `jobs.create(...)` call (the way
`triggeringQuestionIds` is added today) would be silently dropped before the completion handler
ever sees it. The field must be declared on the schema (and the core input type it satisfies)
to survive.

> **Discovered, out of scope:** `triggeringQuestionIds` and `openPullRequests` are added to the
> draft job input the same passthrough way and are **also** stripped today — so autonomous
> proposals silently lose their triggering-question provenance and the open-PR draft context.
> This is a real pre-existing bug but a separate concern; it is flagged for a follow-up, not
> fixed here.

## The fix

Declare `gapClusterId` on the draft job contract and thread it cluster → job → proposal.

1. **Core type** — add `gapClusterId?: string` to the draft-markdown-proposal input type in
   `@magpie/core` (the type `draftMarkdownProposalInputSchema` satisfies).
2. **Schema** — add `gapClusterId: z.string().optional()` to `draftMarkdownProposalInputSchema`
   (`packages/jobs/src/schemas.ts`) so the broker preserves it.
3. **`draftFromGaps`** (`apps/api/src/features/proposals/service.ts`) — accept an optional
   `gapClusterId` in its overrides and include it in the job input.
4. **`draftFromCluster`** (`apps/api/src/features/gaps/service.ts`) — pass
   `gapClusterId: clusterId` (it already has the cluster id).
5. **`createProposalFromCompletedJob`** — read `input.gapClusterId` and pass it to
   `proposals.create({ …, gapClusterId })` (`ProposalInput` already supports the field).

The on-demand HTTP draft path passes no `gapClusterId` and is unchanged (those proposals stay
unlinked, exactly as today).

## Data flow (after)

```
reconciler: draftProposalsForUncoveredClusters
  → draftFromCluster(clusterId)            [knows the cluster]
    → draftFromGaps(..., { gapClusterId })  [puts it in the job input]
      → jobs.create("draft_markdown_proposal", { …, gapClusterId })  [schema keeps it]
        → (watcher drafts) → completeJob
          → createProposalFromCompletedJob   [reads input.gapClusterId]
            → proposals.create({ …, gapClusterId })   [proposal now linked]
```

Next reconcile: the cluster is covered → not re-drafted; `proposalForCluster` finds it.

## Components touched

| File | Change |
| --- | --- |
| `packages/core/src/index.ts` | add optional `gapClusterId` to the draft input type |
| `packages/jobs/src/schemas.ts` | add `gapClusterId: z.string().optional()` to the input schema |
| `apps/api/src/features/proposals/service.ts` | thread `gapClusterId` in `draftFromGaps` + read it in `createProposalFromCompletedJob` |
| `apps/api/src/features/gaps/service.ts` | `draftFromCluster` passes `gapClusterId: clusterId` |

No store, migration, or job-type changes — `gapClusterId` is already a `Proposal`/`ProposalInput`
field and an existing column.

## Testing

- **Link set:** a `draft_markdown_proposal` job whose input carries `gapClusterId` produces, via
  `createProposalFromCompletedJob`, a proposal with that `gapClusterId`.
- **No duplicate re-draft (the bug, regression-tested):** with a cluster that already has a
  linked proposal, a reconcile run does **not** enqueue a second draft for it. (Drive it through
  `reconcileGaps`/`draftProposalsForUncoveredClusters` with the in-memory harness.)
- **Schema preserves the field:** `draftMarkdownProposalInputSchema.parse({ …, gapClusterId })`
  keeps `gapClusterId` (guards against the strip).
- **On-demand path unchanged:** `draftFromGaps` with no `gapClusterId` → job input has none →
  proposal unlinked.
- **Gates:** root `npm run typecheck` and `npm run deadcode` (knip strict) stay green.

## Out-of-scope follow-up

The `triggeringQuestionIds` / `openPullRequests` strip (same mechanism) — fix by declaring them
on the schema + core type, then verifying merge-time gap resolution and draft context recover.
And then the **fold** increment, which builds on this clean link.
