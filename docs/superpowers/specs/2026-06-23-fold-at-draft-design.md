# Fold a freshly-drafted proposal into an overlapping open PR — design

**Status:** Approved (brainstormed 2026-06-23) · **Author:** Adam

The increment that makes the reconcile gate *act*. Until now the gate only **observes**
overlap (cross-linking two open PRs, PR #21) and **prevents re-drafting** a covered cluster
(PR #22). This increment makes a freshly-drafted proposal that overlaps an existing open PR
**fold into it** — an LLM merges the two documents and the rival is discarded before it ever
becomes a competing PR. Part of the knowledge-base maintenance redesign
([`docs/maintenance-redesign.md`](../../maintenance-redesign.md) §5).

## The model (recap)

Every lens emits a `ChangeIntent`; the spine's `decideReconciliation`
([`apps/api/src/scheduling/reconcile-gate.ts`](../../../apps/api/src/scheduling/reconcile-gate.ts))
already returns `open-new` / `fold` / `defer` keyed by file-set overlap within one flow. This
increment wires the **`fold`** verdict to a real action for the gap lens: at draft-completion
time, a newly-created proposal **B** that overlaps a touchable open proposal **A** is folded
into A by an LLM, and B is superseded.

"Touchable = open" for now (any non-terminal proposal: draft / ready / branch-pushed /
pr-opened), exactly as `openPullRequestSummaries` already computes. Approval/review-state
tracking — the spine's intended "open **and** un-approved" guard — remains a later follow-up.

## Where it hooks: the completion dispatcher (at-draft)

The gap→PR path is: reconciler enqueues a `draft_markdown_proposal` job → watcher drafts →
`completeJob` ([`apps/api/src/features/jobs/service.ts:124`](../../../apps/api/src/features/jobs/service.ts:124))
→ `createProposalFromCompletedJob` mints proposal **B** (status `draft`). Today nothing
auto-publishes a fresh draft — it sits at `draft` until a human marks it ready or a
merge/split enqueues its publication — so intercepting at draft-completion is race-free: B is
inert until we decide its fate.

A new dispatcher step runs **immediately after** B is created:

```
completeJob
  └─ createProposalFromCompletedJob → B (draft)
  └─ foldService.reconcileDraftedProposal(ctx, B)        ← NEW
       ├─ compute B's flow; gather that flow's other touchable proposals
       ├─ decideReconciliation({ lens:"gap", flowId, targets:[B.targetPath], … }, summaries)
       └─ if fold → enqueue fold_markdown_proposal { survivor A, rival B, both markdowns }
          else      → no-op (B follows the normal path unchanged)
```

`reconcileDraftedProposal` filters open proposals to **B's own flow** (the gate never reasons
across flows) and **excludes B itself** before calling `openPullRequestSummaries` +
`decideReconciliation`. Only a `fold` verdict acts; `open-new` and `defer` leave B exactly as
it is today.

## The fold job (`fold_markdown_proposal`, provider capability)

A new AI job, run by the watcher's `ChatRunner` via the generic chat path (no special runner
method needed — add it to `CHAT_JOB_TYPES` and `buildPrompt`).

- **Input:** `{ provider, survivorProposalId, rivalProposalId, targetPath, survivorMarkdown,
  rivalMarkdown, rivalGapSummaries, rivalEvidence, expectedOutput: "folded_markdown" }`.
- **Output:** `{ markdown, rationale }` — the single reconciled document for A, plus a short
  note on what was folded in.
- **Prompt:** a new `FOLD_MARKDOWN_PROPOSAL` entry in `@magpie/prompts` instructing the model
  to merge the rival's content into the survivor coherently, without losing either's facts and
  without duplicating sections (this is the LLM resolution §5 calls for — never a mechanical
  merge).

## Applying the fold (a new completion handler)

A second new dispatcher step, `foldService.applyFoldFromCompletedJob`, fires when a
`fold_markdown_proposal` job completes:

1. **Update A's content** — `proposals.updateMarkdown(A.id, output.markdown)` (a new store
   method; A's title/targetPath/branch are unchanged, so its PR is updated in place).
2. **Absorb B's cluster into A's** — move B's cluster's gap memberships onto A's cluster and
   freeze B's cluster, reusing the `assignGapToCluster` + `freezeCluster` machinery from
   `applyMerge`. Viable only because PR #22 links proposals to clusters. This makes the gaps B
   addressed resolve when **A** merges, and stops B's cluster being re-drafted.
3. **Supersede B** — `updateStatus(B.id, "superseded")`. B never published, so there is no PR
   to close.
4. **Re-publish A** — `enqueuePublicationAction(A.id, "publish")`, drained by the next
   reconcile tick (identical to `applyMerge`/`applySplit`). A's branch name is deterministic,
   so the existing PR updates rather than a new one opening.
5. **Comment on A** (reviewer transparency) — **only if A already has an open PR**
   (`A.publication?.pullRequestUrl`): enqueue a `comment_pull_request` github job noting that
   B's gaps were folded in. When A has no PR yet, the merged content simply becomes A's PR on
   first publish, so no separate comment is needed.

## Safety fallback: never lose the gap

If the fold job fails terminally, B must still become a PR (its gap can't silently vanish):

- In `failJob` ([`apps/api/src/features/jobs/service.ts:235`](../../../apps/api/src/features/jobs/service.ts:235)),
  when a `fold_markdown_proposal` job ends `failed`, read `rivalProposalId` from its input and
  `enqueuePublicationAction(B.id, "publish")`. B publishes as its own PR and the PR #21
  cross-link backstop then catches the A/B overlap.
- The `invalid_output` branch of `completeJob` calls `ctx.jobs.fail` directly (bypassing
  `failJob`), so the same fallback is invoked there when the failing job is a fold job.

This mirrors the existing crunch / source-sync run-failure side effects already in `failJob`.

## New github job: `comment_pull_request`

A minimal github-capability job, handled by the `PublicationRunner` (which already holds
`commentOnPullRequest` in its deps and uses it for `crosslink_pull_requests`):

- **Input:** `{ pullRequestUrl, body }`. **Output:** `{ commentUrl?: string }`.
- Add to `JOB_TYPES`, `catalog`, `PUBLISH_JOB_TYPES`, and one `run` case calling
  `deps.commentOnPullRequest`. `crosslink_pull_requests` won't serve here — it needs two PRs,
  and B never has one.

## Components touched

| File | Change |
| --- | --- |
| `packages/core/src/index.ts` | `FoldMarkdownProposalJobInput` / `…Output` types |
| `packages/jobs/src/types.ts` | add `fold_markdown_proposal`, `comment_pull_request` to `JOB_TYPES` |
| `packages/jobs/src/schemas.ts` | fold in/out schemas + `comment_pull_request` in/out schemas |
| `packages/jobs/src/catalog.ts` | `define(...)` both jobs; add fold to `aiJobTypes` |
| `packages/prompts/src/catalog.ts` | `FOLD_MARKDOWN_PROPOSAL` prompt |
| `apps/watcher/src/job-prompts.ts` | `buildPrompt` case for fold |
| `apps/watcher/src/runners/chat.ts` | add fold to `CHAT_JOB_TYPES` |
| `apps/watcher/src/runners/publication.ts` | `comment_pull_request` case + `PUBLISH_JOB_TYPES` |
| `apps/api/src/stores/proposal-store.ts` | `updateMarkdown` on interface + in-memory store |
| `apps/api/src/stores/postgres-proposal-store.ts` | `updateMarkdown` |
| `apps/api/src/scheduling/fold.ts` (new) | `reconcileDraftedProposal` + `applyFoldFromCompletedJob` + fallback helper |
| `apps/api/src/features/jobs/service.ts` | dispatcher steps in `completeJob`; fallback in `failJob` + `invalid_output` |

No DB migration: `superseded` status and the gap-cluster/publication-action stores already
exist; only a `markdown` column update is added (the column exists).

## Testing

- **At-draft fold prevents the rival (the headline, regression-tested):** complete a draft
  job for B whose `targetPath` overlaps an open proposal A → a `fold_markdown_proposal` job is
  enqueued and **no** rival PR path runs for B.
- **Apply fold:** completing a `fold_markdown_proposal` job updates A's markdown, supersedes B,
  absorbs B's cluster (gaps now hang off A's cluster, B's cluster frozen), and enqueues A's
  publish action.
- **No overlap → no fold:** B with a non-overlapping `targetPath` is left untouched
  (`open-new`).
- **Cross-flow isolation:** an open PR in another flow does not trigger a fold.
- **Fallback:** a failed `fold_markdown_proposal` job enqueues B's publish action.
- **Contracts:** fold + `comment_pull_request` schemas round-trip; `ChatRunner.supports` /
  `PublicationRunner.supports` recognise the new types.
- **Gates:** root `npm run typecheck` and `npm run deadcode` (knip strict) stay green.

## Out of scope (unchanged from the redesign backlog)

- Approval/review-state tracking so fold respects "touchable = open **and** un-approved".
- Soft (topic) overlap folding — this increment only acts on hard file-set overlap.
- The `triggeringQuestionIds` / `openPullRequests` draft-input strip (separate follow-up).
