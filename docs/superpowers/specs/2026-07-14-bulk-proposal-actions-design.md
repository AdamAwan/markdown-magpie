# Bulk proposal actions — design

**Date:** 2026-07-14
**Status:** Approved

## Problem

Working a long proposal backlog in the console means clicking Mark Ready / Publish /
Accept / Reject one proposal at a time. Every click triggers a full console refresh:
actioned proposals drop out of the list, the selection snaps back to the top, and the
page jumps around. Two aggravators: the fast-tier poll fetches only 8 proposals (so the
visible list is a small window onto the backlog), and each single action re-fetches
everything.

## Decisions (made with Adam)

1. **Selection UX:** checkboxes on list rows plus a select-all toggle, with a bulk
   action bar — not per-stage "do all" buttons.
2. **Actions:** the full per-proposal set — Mark Ready, Publish, Accept/Merge, and
   Reject/Bin.
3. **Scope:** also raise the proposals fetch limit (8 → 100) and collapse bulk work to
   a single refresh, fixing the page-jumping.
4. **Backend:** a new batch endpoint (not a client-side fan-out over the single-item
   routes).

## API — `POST /api/proposals/bulk`

Body (zod): `{ action: "ready" | "publish" | "merge" | "reject", ids: string[] }`,
1–100 ids, `manage:knowledge` scope. Ids are processed **sequentially** (keeps
checkout-lock contention sane) and each composes the existing service functions — no
guard logic is duplicated:

| action | eligible | effect |
|---|---|---|
| `ready` | status `draft` | `updateStatus(ready)` |
| `publish` | status `ready` | `requestProposalPublication` (enqueues the existing publish job) |
| `merge` | local-git `branch-pushed` | `mergeLocalProposal` + background merge cascade |
| `merge` | GitHub `branch-pushed`, no PR URL | `updateStatus(merged)` + cascade, gated on the prior status (retry-safe, mirrors the single route) |
| `merge` | any proposal with a live PR URL | skipped: `proposal_merge_tracked_by_pull_request` |
| `reject` | local-git `branch-pushed` | `rejectLocalProposal` (bin: delete branch, freeze cluster) |
| `reject` | GitHub `draft` | `updateStatus(rejected)` |

Anything else reports `invalid_status` for that id. Per-id auth mirrors the single
routes: unreadable/cross-flow ids mask as `proposal_not_found`; readable but not
manageable reports `forbidden` — a bad id never fails the whole batch.

Response is always `200 { results: [{ id, ok, code?, proposal?, job? }] }` (400 only
for a malformed body). Merge cascades run on `ctx.background` exactly as the single
routes do.

## Console

- **List window:** the fast-tier poll's proposals fetch goes from `limit=8` to
  `limit=100` (matching the jobs list) so select-all covers the real backlog. Known
  trade-off: proposals carry full markdown, so the 4s active-job poll ships more bytes;
  acceptable for an operator console.
- **Selection:** each row gets a checkbox (row click still previews; the checkbox is a
  separate target), a select-all toggle and count in the list header. Selection state
  lives in the panel and self-prunes when ids leave the list.
- **Bulk bar:** renders when selection is non-empty: Mark Ready (n) · Publish (n) ·
  Accept/Merge (n) · Reject/Bin (n), where n counts the selected proposals eligible for
  that action (same table as above, computed client-side; the server re-guards).
  Zero-eligible buttons are disabled. One click → one `bulkProposalAction` call in
  ConsoleProvider → one summary message ("Merged 7 · skipped 2: PR-tracked") → **one**
  refresh.
- **Selection anchoring:** if the previewed proposal survives the refresh it stays
  selected; if it dropped out (merged/rejected), selection moves to the nearest
  remaining neighbour instead of snapping to `proposals[0]`.

## Testing

- API: `routes.bulk.test.ts` — each action's happy path, mixed statuses, PR-tracked
  merge skip, not-found masking for cross-flow ids, forbidden per-id, re-run
  idempotency (bulk-merging an already-merged id reports `invalid_status` and never
  re-enqueues the cascade).
- Web: `ProposalsPanel.test.tsx` — checkbox/select-all behaviour, eligibility counts,
  bulk bar dispatch; ConsoleProvider anchoring covered via the panel tests' handlers.

## Out of scope

- Acting on proposals beyond the fetched page ("merge ALL ready server-side" with no
  ids) — the ids stay explicit so the UI and the API agree on what was acted on.
- A summary/`fields=` mode on `GET /proposals` to slim the poll payload.
