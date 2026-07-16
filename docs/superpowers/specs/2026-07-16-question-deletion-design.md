# Delete a question (with optional full scrub)

Status: approved (2026-07-16)

## Problem

A user can ask a question that contains sensitive information (a pasted secret,
PII, an internal identifier). Magpie logs every question — its text, the answer,
citations, and derived knowledge gaps — and those gaps can propagate downstream:

```
question → question_gaps.summary → gap_clusters (title / rationale / representative
embedding) → drafted proposal (markdown / rationale / gapSummary / title) → pushed
branch / open PR / merged doc
```

Today there is **no way to purge a single logged question**. The only delete is
`reset()` (wipe everything). This adds a targeted delete with two modes.

## Goal / non-goal

Give an admin a way to purge a logged question when it contains sensitive info:
either the **question record alone**, or a **full scrub** that also removes the
downstream artifacts that absorbed the question's text.

**Non-goal (surfaced in the UI):** this purges Magpie's *stored* copy only. It
cannot retract text already sent to the configured AI provider, nor content
already pushed to a branch / open PR / merged document. Those published artifacts
are *reported* so a human can handle them out of band.

## Two modes

Both are exposed on one endpoint via a `scrub` flag.

### Mode 1 — Delete question (`scrub: false`)

`DELETE FROM questions WHERE id = :id`. The existing DB `ON DELETE CASCADE`
removes the question's `answer_citations`, `question_gaps`, and (via the gap FK)
`gap_cluster_memberships`. The in-memory store's `delete()` mirrors this. Nothing
downstream (clusters, proposals) is touched.

### Mode 2 — Full scrub (`scrub: true`)

Mode 1, plus:

- **Clusters.** For every gap cluster the deleted question's gaps belonged to
  (captured *before* deletion): after the memberships are removed, reload the
  cluster's active memberships. If it now has **zero** active members, dismiss it
  and overwrite its `title`/`rationale` with a neutral placeholder
  (`[scrubbed]`) so no question-derived label survives. If it still has other
  members, clear its `representative_embedding` (forces a lazy recompute from the
  surviving members on the next assignment pass) — the multi-gap title is left
  for the reconciler to re-derive.
- **Proposals.** For every proposal whose `triggeringQuestionIds` contains the
  question id: if it has **no** `publication` (still draft/ready — never pushed),
  **delete** it. If it has a `publication` (branch-pushed / pr-opened / merged),
  **do not touch the remote** — collect it into a `warnings` list. Publishing is
  always a human action; un-publishing is too.

## API

`DELETE /api/questions/:id`, gated by **`manage:admin`** (the highest-privilege
scope, consistent with the destructive config/reset endpoints). The `scrub` flag
is read from the query string (`?scrub=true`).

Returns `200` with a report:

```jsonc
{
  "deleted": {
    "question": true,
    "citations": 2,
    "gaps": 1,
    "clustersDismissed": 0,
    "clustersRecomputed": 1,
    "proposals": 1
  },
  "warnings": [
    { "proposalId": "…", "title": "…", "status": "pr-opened", "pullRequestUrl": "https://…" }
  ]
}
```

`404 { error: "question_not_found" }` if no such question. For `scrub: false`,
the cluster/proposal counts are `0` and `warnings` is empty.

## Stores (new methods; Postgres + in-memory impls kept in lockstep)

- `QuestionLogStore`
  - `delete(id): Promise<boolean>` — transactional delete of the question (cascade
    handles citations/gaps/memberships in PG; the in-memory store removes them
    explicitly). Returns whether a row existed.
  - `gapIdsForQuestion(id): Promise<string[]>` — the question's gap ids in the
    same id format memberships use (`qg.id::text` in PG, `\`${logId}::${summary}\``
    in memory), captured before deletion so scrub can find affected clusters.
- `GapClusterStore`
  - `clusterIdsForGaps(gapIds): Promise<string[]>` — distinct active-membership
    cluster ids for the given gaps.
- `ProposalStore`
  - `listByTriggeringQuestionId(id): Promise<Proposal[]>` — proposals whose
    `triggering_question_ids` array contains the id.
  - `delete(id): Promise<boolean>` — hard-delete one proposal row (cascades its
    `gap_publication_actions`). Only ever called for unpublished proposals.

## Service

A `questionsService.deleteQuestion(ctx, id, { scrub })` orchestrates across the
three stores (a service, not a single store method, because the scrub spans the
question / cluster / proposal stores which are independent). Order:

1. `get(id)` → 404 if absent.
2. `gapIds = gapIdsForQuestion(id)`; if scrubbing, `affectedClusterIds =
   clusterIdsForGaps(gapIds)` and load the triggered proposals.
3. `delete(id)` (mode 1 cascade).
4. If scrubbing: `deactivateMembershipsForGaps(gapIds)` (normalises the in-memory
   cluster store; a no-op in PG where the cascade already removed them), then per
   affected cluster dismiss-or-recompute, then delete unpublished proposals and
   collect warnings for published ones.
5. Return the report.

## Web

In the Ask panel's **"Answered questions"** list, add a **Delete** action per row.
It opens a small confirm dialog with two actions — **Delete question** and **Full
scrub** — plus the non-goal caveat. After a full scrub, if `warnings` is
non-empty, show them (with PR links) so the admin knows what still needs manual
handling. On success the row is removed from the list and the page refetched.

**Access control is server-side only.** The console has no client-side scope
state (auth can be disabled entirely, and it is a single-tenant admin console),
and existing `manage:admin` actions — the whole Config page — are shown to every
operator and enforced by the API, not hidden client-side. The Delete action
follows that established pattern: it is always rendered, and the API's
`manage:admin` gate rejects an under-scoped caller with `403` (surfaced as an
error toast). Client-side gating would require decoding the access token's scopes,
which the web app does not do for any other action.

## Testing

- Store: both modes' cascade counts; empty-cluster dismissal + placeholder title;
  representative-embedding clear on a still-populated cluster;
  unpublished-vs-published proposal split; `gapIdsForQuestion` /
  `clusterIdsForGaps` / `listByTriggeringQuestionId` shapes (unit + a
  Postgres-backed integration test for the cascade).
- Route: `manage:admin` gate (403 without it), 404, mode-1 vs mode-2 report and
  warnings shape.
- Web: the action is gated on `manage:admin`; the confirm dialog offers both
  modes; a full scrub surfaces published-proposal warnings.

## Out of scope

- Un-publishing / closing remote PRs or deleting pushed branches (reported only).
- Re-titling still-populated clusters via a model call (left to the reconciler).
- Bulk / by-substring deletion (one question at a time).
