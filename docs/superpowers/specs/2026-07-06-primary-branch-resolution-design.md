# Single-source primary-branch resolution

**Date:** 2026-07-06
**Status:** Design approved, pending implementation plan

## Problem

A repository's "primary branch" (the base a proposal branches from, the PR base, and
the branch a local-git proposal merges into) is re-derived independently in several
places, each with a *different and non-overlapping* fallback chain. The paths disagree,
which produces failures like:

- Create a proposal branch → `git worktree add ... master` → `fatal: invalid reference: master`
- Accept the same proposal → `git checkout main` → `error: pathspec 'main' did not match`

on the *same repository*, because one path resolved `master` and the other `main`.

### Current divergent logic

| Path | Source it reads | Fallback chain |
|------|-----------------|----------------|
| Registration (`indexLocalRepository`, `apps/api/src/stores/knowledge-index.ts:195`) | git detection | `git.defaultBranch ?? git.currentBranch ?? "main"` |
| Base ref for worktree (`resolveBaseRef`, `packages/git/src/index.ts:1174`) | repo ref + git detection | `repo.defaultBranch \|\| git.defaultBranch \|\| git.currentBranch \|\| "main"` |
| PR base (`apps/watcher/src/runners/publication.ts:216`) | repo ref + git detection | `repo.defaultBranch \|\| git.defaultBranch \|\| "main"` (**no `currentBranch`**) |
| Local-git merge (`apps/api/src/features/proposals/service.ts:797`) | **config** `branch` | `destination.branch?.trim() \|\| "main"` |
| Local-git reject (`apps/api/src/features/proposals/service.ts:866`) | **config** `branch` | `destination.branch?.trim() \|\| "main"` |

Two independent problems fall out of this table:

1. **No shared precedence.** The merge/reject paths read the config `branch` and never
   consult git detection; the create/base paths read git detection and never consult the
   config `branch`. They cannot agree except by coincidence.
2. **`git.defaultBranch` is frequently empty.** `detectGitContext`
   (`apps/api/src/stores/knowledge-index.ts:982`) sets `defaultBranch` only from
   `symbolic-ref refs/remotes/origin/HEAD`, which is absent for a freshly-cloned or
   just-initialised repo with no fetched `origin/HEAD`. The fallbacks then diverge as above.

The config already exposes a branch knob — `ConfiguredKnowledgeRepository.branch`
(`apps/api/src/stores/knowledge-repositories.ts:10`) — but it is only used to decide
*which branch to check out* (`ensureGitCheckout`) and, separately, in merge/reject. It is
never propagated into `RepositoryRef.defaultBranch` and never seen by the base/PR paths.

## Goals

- One precedence, applied everywhere, so create/base, PR, merge, and reject can never
  disagree about a repo's primary branch.
- The config `branch` is authoritative when set; git detection fills the gap otherwise;
  `"main"` is only a last-resort default.
- A missing/misconfigured branch fails with a clear, actionable message rather than git's
  opaque `invalid reference` / `pathspec did not match`.

## Non-goals

- No change to how *which* branch is checked out beyond making it consult the same
  resolved value (checkout already honours config `branch`).
- No new required config. Repos that set nothing keep working via detection.
- No migration/backfill of stored `default_branch` beyond what re-indexing naturally
  recomputes.

## Design

### 1. One precedence function

A pure helper encoding the single precedence order. It takes the three candidate inputs
and returns a concrete branch name:

```ts
// resolvePrimaryBranch — the ONLY place the precedence lives.
resolvePrimaryBranch({ configuredBranch, detectedDefault, detectedCurrent }): string =
  nonEmpty(configuredBranch)   // config `branch` — authoritative when set
  ?? nonEmpty(detectedDefault) // origin/HEAD symbolic-ref
  ?? nonEmpty(detectedCurrent) // git branch --show-current
  ?? "main"                    // last resort
```

`nonEmpty` trims and treats `""`/whitespace as absent.

**Location:** `@magpie/core` (it operates on plain strings and is consumed by `@magpie/git`,
`apps/api`, and `apps/watcher`; core is the shared dependency with no cycles). If core is
an awkward fit at implementation time, `@magpie/git` is the fallback home.

### 2. `RepositoryRef.defaultBranch` becomes the authoritative carrier

At the points that build a `RepositoryRef` from configuration + detection — registration
(`indexLocalRepository`, `knowledge-index.ts:195`) and any config-repo preparation that
has both the `ConfiguredKnowledgeRepository` and a detected `GitRepositoryContext` — set
`defaultBranch` via `resolvePrimaryBranch`, passing the **config `branch` as
`configuredBranch`** (it is currently omitted). After this, `RepositoryRef.defaultBranch`
is always a real, config-aware branch name — never empty, never a bare guess.

### 3. Consumers stop re-deriving

- **`resolveBaseRef`** (`packages/git/src/index.ts:1174`): read `repository.defaultBranch`
  directly. Keep only the `origin/<branch>` existence check that chooses between
  `origin/<branch>` and the bare local `<branch>`. Drop the
  `|| git.defaultBranch || git.currentBranch || "main"` tail — `defaultBranch` is now
  authoritative.
- **PR base** (`apps/watcher/src/runners/publication.ts:216`): use
  `repository.defaultBranch` instead of its own `|| ... || "main"` chain.
- **Merge / reject** (`apps/api/src/features/proposals/service.ts:797,866`): use the
  proposal's already-resolved `repository.defaultBranch`. It is already threaded into the
  execution-context repository view (`service.ts:1072-1073`), so the merge/reject helpers
  read that instead of `destination.branch?.trim() || "main"`.

### 4. Fail loudly on a non-existent branch

When a resolved branch cannot be used at worktree-add / checkout time, surface a clear
error — e.g. `configured default branch "<branch>" does not exist in <repo>` — instead of
letting git emit `invalid reference` / `pathspec did not match`. This covers the
misconfiguration case (config says `master`, repo only has `main`) with a message that
names the cause.

## Data flow (after)

```
config `branch` ─┐
                 ├─ resolvePrimaryBranch ─→ RepositoryRef.defaultBranch ─┬─→ resolveBaseRef (worktree base)
git detection ───┘   (at registration/prep)                             ├─→ PR base (publication)
                                                                         └─→ merge / reject (local-git)
```

Every downstream consumer reads one field produced by one function.

## Testing

- **Unit — `resolvePrimaryBranch`:** config wins over detection; `origin/HEAD` default used
  when config absent; `currentBranch` used when both absent; `"main"` when all absent;
  whitespace/empty treated as absent at each level.
- **Unit — registration:** `RepositoryRef.defaultBranch` reflects config `branch` when set,
  else detected default, else current, for a repo with/without `origin/HEAD`.
- **Integration — parity:** for a repo whose only branch is `X` (no `origin/HEAD`, config
  unset), the base-ref path and the merge/reject path resolve the *same* `X`. A regression
  guard for the exact create-vs-accept divergence in this bug.
- **Integration — misconfiguration:** config `branch: master` against a repo that only has
  `main` produces the clear named error, not git's opaque one.

## Rollout / compatibility

- Existing repos with a populated `origin/HEAD` see no behaviour change (detection still
  yields the same default).
- Repos relying on the accidental `"main"` fallback in merge/reject while detection said
  something else will now converge on the detected/configured branch — this is the intended
  fix, and the parity test documents it.
- No schema migration required; `default_branch` is recomputed on re-index.
