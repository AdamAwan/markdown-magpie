# Reject a local-git proposal before publishing — design

Date: 2026-07-16

## Problem

A local-git proposal can only be rejected ("Bin") once it reaches `branch-pushed`
status — i.e. the user must first mark it `ready` and publish a review branch
before they are allowed to bin it. There is no way to reject an unwanted proposal
early, while it is still `draft` or `ready`.

The gate lives in `rejectLocalProposal`
(`apps/api/src/features/proposals/service.ts`):

```ts
if (proposal.status !== "branch-pushed" || !proposal.publication?.branchName) {
  return { ok: false, code: "proposal_not_rejectable",
           message: "Only a branch-pushed proposal with a published branch can be rejected." };
}
```

and is mirrored in the web eligibility checks.

## Goal

Allow a local-git proposal to be rejected from **any non-terminal status**
(`draft`, `ready`, `branch-pushed`) — anything not already in
`TERMINAL_PROPOSAL_STATUSES` (`merged`, `rejected`, `superseded`). When a review
branch was actually pushed, still delete it; when none exists, skip the branch
delete. Marking `rejected` and freezing the gap cluster happen in all cases.

Hosted / GitHub proposals are out of scope — their reject stays `draft`-only and
uses a different mechanism (`POST /:id/status`).

## Changes

### 1. Service — `rejectLocalProposal` (`apps/api/src/features/proposals/service.ts`)

- Replace the `status !== "branch-pushed"` guard with a terminal-status guard:

  ```ts
  if (TERMINAL_PROPOSAL_STATUSES.includes(proposal.status)) {
    return { ok: false, code: "proposal_not_rejectable",
             message: "A merged, rejected, or superseded proposal cannot be rejected." };
  }
  ```

- Keep the local-git-destination check unchanged.
- Keep mark-rejected + freeze-cluster unchanged (authoritative state, happens first).
- Make the branch-delete block **conditional on `proposal.publication?.branchName`** —
  skip it entirely when there is no pushed branch. Best-effort semantics for the
  delete itself are unchanged.
- Update the function doc comment (currently describes a `branch-pushed`-only bin)
  to reflect that reject now applies pre-publish too, with the branch delete
  being conditional.

`TERMINAL_PROPOSAL_STATUSES` is exported from `@magpie/core` and already imported
where needed / import it.

### 2. Web eligibility — `apps/web/src/lib/console.ts` (`bulkActionEligible`)

```ts
case "reject":
  return proposal.localGitDestination
    ? !TERMINAL_PROPOSAL_STATUSES.includes(proposal.status)   // was: === "branch-pushed"
    : proposal.status === "draft";
```

### 3. Web detail button — `apps/web/src/components/ProposalsPanel.tsx`

The local-git "Bin" button's `disabled` condition changes from
`status !== "branch-pushed"` to the same non-terminal check
(`TERMINAL_PROPOSAL_STATUSES.includes(status)`).

### Not needed: bulk route

`applyBulkAction`'s `reject` case
(`apps/api/src/features/proposals/routes.ts`) already delegates local-git
proposals to `rejectLocalProposal`. It inherits the relaxed guard automatically —
no change required.

## Testing

Unit tests for `rejectLocalProposal` (injected `deleteBranch` spy):

- `draft`, no publication branch → rejected + cluster frozen, `deleteBranch` NOT called.
- `ready`, no publication branch → same.
- `branch-pushed` with branch → rejected + cluster frozen, `deleteBranch` called.
- terminal status (`merged`/`rejected`) → `proposal_not_rejectable`, no state change.
- non-local-git destination → `not_local_git_destination` (unchanged behavior).

## Out of scope

- Hosted/GitHub reject behavior.
- The `/:id/reject` route shape and `manage:knowledge` scope.
