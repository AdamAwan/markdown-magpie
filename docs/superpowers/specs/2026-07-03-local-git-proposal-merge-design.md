# Local-git Proposal Merge — Design

Date: 2026-07-03

## Goal

Let a presenter run the whole knowledge-maintenance loop against a **local git
repository** with no GitHub and no pull requests. When a proposal's destination
is a local-git repo, the existing "Mark Merged" button on the Proposals page
becomes a real **Merge** button: it performs the actual `git merge` of the
proposal's pushed branch into the destination's default branch — so the improved
Markdown lands in the folder the presenter is browsing — and then reuses the
existing merge cascade (resolve gaps, re-index).

This closes the one gap left by publishing to a local-git destination: magpie
already clones the repo, drafts a proposal, and pushes a `magpie/proposal-…`
branch **into** it, but nothing moves that branch onto the default branch. Today
"Mark Merged" only flips magpie's internal status; it never touches git.

## Definitions

- **Local-git destination** — a configured knowledge *destination* whose git
  remote URL uses the `file:` scheme (e.g. `file:///D:/demo-kb`). This is the
  only kind of destination this feature acts on. A non-git `kind: "local"` path
  (a directory that is not a git repo) is explicitly **out of scope**.
- Every intended KB change already flows through a `Proposal` (gap-fills,
  source-sync, dedupe, split, patrols, fold), so acting at the proposal-merge
  step covers the entire maintenance surface, not just gaps.

## Non-goals

- No new page. We repurpose the existing button on the Proposals page.
- No new job / watcher runner. The merge is a **synchronous API action** (git is
  mechanical, not generative, so it does not touch the queue-only rule; the API
  already runs git for source-sync and re-index).
- No change to how proposals are generated or published as branches.
- No "merge all" / bulk action.
- No changes to the GitHub/hosted path beyond leaving it untouched. (A separate
  task tidies up the now-redundant manual "Mark Merged" for hosted destinations,
  where the `refresh_flow_snapshot` poller + `applyPullRequestTransition` already
  own the `pr-opened → merged` transition.)
- Not for production. Documented as a demo/local convenience, like the reset
  button.

## Architecture

### 1. Detecting a local-git destination

A single helper resolves a proposal's destination and reports whether it is
local-git:

```
isLocalGitDestination(ctx, proposal): boolean
```

It looks the proposal's destination up in the in-memory configured destinations
(`ctx` app config — no git, no network) and returns `true` when the destination's
git remote URL parses with a `file:` scheme. This is cheap enough to compute per
proposal when listing.

`proposalsService.list` and `.get` attach the computed boolean
`localGitDestination` to each returned proposal so the web UI can switch the
button without parsing URLs itself. The stored `Proposal` domain type is
unchanged; the flag is added in the service response mapping (a thin view
augmentation), keeping persistence clean.

### 2. Git merge helper (`packages/git`)

Git logic stays in `@magpie/git`, next to `LocalGitProposalPublisher`. New export:

```
mergeLocalProposalBranch({ repoPath, branchName, defaultBranch }): Promise<{ mergeCommitSha: string }>
```

Serialized with the existing `withCheckoutLock(repoPath, …)` so concurrent merges
of the same repo can't race. Steps, all in `repoPath` (the origin working tree
the presenter browses — the branch is already a local ref there because magpie
pushed it in):

1. `git checkout <defaultBranch>`.
2. `git merge --no-ff --no-edit <branchName>`.
3. On success: read the merge commit sha, then `git branch -d <branchName>`
   (best-effort delete; a failed delete does not fail the merge).
4. **On any failure** (conflict, dirty tree, missing branch): `git merge --abort`
   (best-effort), then throw a typed error. The working tree is left on
   `<defaultBranch>` unchanged, and the proposal branch is left intact.

Assumes the destination repo's working tree is clean (it is bot-owned in the demo
setup). A dirty tree makes the merge abort and surfaces an error rather than
guessing.

### 3. Endpoint: `POST /api/proposals/:id/merge`

Mirrors the auth and flow-scoping of the existing `/:id/status` route
(`requireScopes("manage:knowledge")`, hide cross-flow proposals as 404, then
`assertCan(ctx, c, "manage", flowId)`).

Service function `proposalsService.mergeLocalProposal(ctx, proposal)`:

1. Guard: proposal status is `branch-pushed` and it has a recorded
   `publication` (branch name + remote). Else `409 proposal_not_mergeable`.
2. Guard: `isLocalGitDestination(ctx, proposal)` is true. Else
   `409 not_local_git_destination` (the hosted path merges via its PR, not here).
3. Resolve the origin path from the publication's `file:` remote
   (`fileURLToPath`) and the destination's `defaultBranch` from the existing
   destination resolver. Branch name comes from `publication.branchName` (no need
   to recompute it).
4. `await mergeLocalProposalBranch({ repoPath, branchName, defaultBranch })`.
   - On the typed merge failure → `409 merge_conflict` with the git message, and
     **the proposal is left at `branch-pushed`** (git and magpie never disagree).
5. On success: `updateStatus(proposal.id, "merged")`, then schedule the existing
   `runMergeCascade` off the request thread via `ctx.background.run` (identical to
   the `/:id/status` merge path) and freeze the proposal's cluster, reusing the
   same helpers the hosted auto-merge uses so the two paths can't drift.
6. Respond `200 { proposal, cascadeScheduled: true }`.

The git merge itself runs **synchronously** inside the request so the button gets
a true success/failure for the merge; only the slower re-index cascade is
backgrounded.

### 4. Concurrency & error handling

- The merge holds the per-repo checkout lock, serializing concurrent merges.
- Known, accepted limitation for this demo-scoped feature: the lock is keyed on
  the origin path, while a *publish* holds the lock on magpie's separate checkout
  clone — so a merge racing an in-flight publish to the same repo is not fully
  serialized. Manual, one-at-a-time demo merges make this negligible; noted rather
  than engineered around.
- All git failures degrade to a `409` with the git message; the proposal status
  is never advanced on failure.

## Frontend — `ProposalsPanel`

The panel already gates the button to `branch-pushed | pr-opened`. Change:

- When `proposal.localGitDestination` is true, the button reads **"Merge"** with
  title "Merge this proposal's branch into the local repo's default branch and
  re-index", enabled only at `branch-pushed`, and calls the new
  `mergeProposal(id)` client action (`POST /proposals/:id/merge`).
- Otherwise the button is unchanged (today's "Mark Merged" status call; subject to
  the separate hosted-path tidy-up).
- On merge success: refresh the proposals list (status now `merged`) and show a
  brief confirmation. On `409 merge_conflict`: surface the git message inline so
  the presenter can resolve it by hand; the proposal stays mergeable.

Wiring lives in the proposals page that composes the panel (adds a `mergeProposal`
handler alongside `publishProposal` / `updateProposalStatus`). `apps/web/src/lib/api.ts`
gains `mergeProposal(id)`. The web `Proposal` type gains
`localGitDestination?: boolean`.

## Data flow

```
Merge (button, branch-pushed, localGitDestination)
  → POST /api/proposals/:id/merge
      → guard: branch-pushed + has publication            (else 409 proposal_not_mergeable)
      → guard: isLocalGitDestination                       (else 409 not_local_git_destination)
      → repoPath = fileURLToPath(publication.remoteUrl); branch = publication.branchName
      → mergeLocalProposalBranch(repoPath, branch, defaultBranch)   [synchronous git]
            checkout defaultBranch → merge --no-ff → delete branch
            on failure: merge --abort + throw               (→ 409 merge_conflict, status unchanged)
      → updateStatus("merged")
      → background: runMergeCascade (fetch/ff checkout → re-index) + freeze cluster
  → 200 { proposal, cascadeScheduled: true }
  → UI refreshes list; file now on default branch in the browsed repo
```

## Testing

- `@magpie/git` (`node:test`, real temp repos via `test-support.ts`):
  - `mergeLocalProposalBranch` merges a pushed branch into `main`, returns a
    commit sha, and deletes the branch.
  - Conflict case: a diverged `main` makes it abort and throw, leaving `main` at
    its pre-merge commit and the proposal branch intact.
- API proposals service/route (in-memory stores):
  - Happy path: `branch-pushed` local-git proposal → status `merged`, cascade
    scheduled. (Git merge is injected/faked at the service boundary so the test
    doesn't shell out.)
  - `not_local_git_destination` for a hosted (non-`file:`) destination.
  - `proposal_not_mergeable` for a non-`branch-pushed` status.
  - `merge_conflict` leaves status at `branch-pushed`.
  - `isLocalGitDestination` true for `file:` remotes, false otherwise.
- Frontend: manual verification in the running app (button reads "Merge",
  click → file appears on the default branch, proposal shows `merged`). No new FE
  test framework.

## Documentation

- `docs/api.md`: document `POST /api/proposals/:id/merge` (no body; `200
  { proposal, cascadeScheduled }`; `409` codes) with the demo/local warning.
- A short note (run-magpie skill or a demo doc) on configuring a `file://`
  local-git destination and that the Merge button — not a PR — lands changes. Call
  out that no `receive.denyCurrentBranch=updateInstead` or hook is needed, because
  the merge runs directly in the destination working tree.

## Files touched (anticipated)

- `packages/git/src/index.ts` (or a new `merge.ts`) — `mergeLocalProposalBranch`.
- `packages/git/src/*.test.ts` — merge helper tests.
- `apps/api/src/features/proposals/service.ts` — `mergeLocalProposal`,
  `isLocalGitDestination`, `localGitDestination` on list/get responses.
- `apps/api/src/features/proposals/routes.ts` — `POST /:id/merge`.
- `apps/api/src/features/proposals/*.test.ts` — service/route tests.
- `apps/web/src/lib/types.ts` — `Proposal.localGitDestination`.
- `apps/web/src/lib/api.ts` — `mergeProposal(id)`.
- `apps/web/src/components/ProposalsPanel.tsx` — button label/behavior switch.
- `apps/web/src/app/proposals/page.tsx` — wire the `mergeProposal` handler.
- `docs/api.md` (+ a demo note) — endpoint docs and local-git setup.
