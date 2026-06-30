# Serialize git checkout access (concurrency fix)

## Problem

Knowledge-gap proposals were stalling in `draft`/`branch-pushed` because publication
intermittently failed with:

```
git pull --ff-only origin main
fatal: Cannot fast-forward to multiple branches.
```

Root cause is concurrent git access to a **shared mutable working tree**:

- In `docker-compose.yml` the `api` and `watcher` services mount the *same* named
  volume `magpie-checkouts:/data/checkouts`, so both processes operate on the same
  `.git` directories.
- Both run mutating git against those trees with no locking: the API runs
  `ensureGitCheckout` (`fetch --prune` + `checkout` + `pull --ff-only`,
  `packages/git/src/index.ts`) on every publish/index/snapshot/source-sync; the
  watcher runs `ensureGitCheckout` + `git worktree add`/push in its publication
  runner (`apps/watcher/src/runners/publication.ts`).
- Concurrent `git fetch`/`git pull` interleave on the single `FETCH_HEAD`, yielding
  "Cannot fast-forward to multiple branches". Under load (a re-publish burst / churn)
  the collision probability spikes.

Each watcher processes one job at a time (`apps/watcher/src/worker-loop.ts`), so the
contention is **API ⇄ watcher** (shared volume) plus the **API racing with itself**
(it calls `ensureGitCheckout` concurrently from the reconcile outbox drain, the
watcher-triggered `getProposalExecutionContext`, snapshot refresh, source-sync and
indexing — one Node process, but interleaved async git).

## Approach (chosen)

Approach 1: **separate the checkout volumes + in-process per-checkout mutex +
idempotent fetch-based sync.** Volume separation removes the cross-process race; the
mutex removes the intra-process race; the sync change removes the specific failing
command deterministically.

Rejected: a cross-process file lock (Approach 2 — solves a problem we opt out of by
separating volumes; revisit if services are scaled horizontally) and an
ephemeral-clone/worktree-per-operation refactor (Approach 3 — larger change, per-op
cost). Both noted as future options.

## Changes

### 1. `@magpie/git`: `withCheckoutLock(key, fn)`

An in-process keyed async mutex. `key` is the absolute checkout **root** path. Calls
with the same key run serially; different keys run concurrently. Implemented as a
promise-chain per key:

```ts
const tails = new Map<string, Promise<unknown>>();
export function withCheckoutLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);              // run regardless of prior outcome
  tails.set(key, run.then(() => {}, () => {})); // non-rejecting tail keeps the chain alive
  return run;
}
```

Map entries are bounded by the number of distinct checkout paths (small), so the map
is not pruned. Released implicitly when `fn` settles.

### 2. Wrap the mutating entry points under the lock

- `ensureGitCheckout` — wrap the clone/fetch/sync block, keyed by the computed
  `localPath` (the checkout root, before any subpath is appended).
- `LocalGitProposalPublisher.publish` and `.publishChangeset` — wrap the whole call
  (worktree add + commit + push + cleanup all touch the shared `.git`), keyed by
  `request.repository.git?.workTreeRoot ?? request.repository.localPath`.

Lock scope is intentionally coarse (whole function); per-checkout serialization is the
goal, and these operations are short.

### 3. Idempotent sync in `ensureGitCheckout`

Replace the two `git pull --ff-only origin <branch>` calls with
`git reset --hard origin/<branch>` (control flow otherwise unchanged — still gated on
`remoteBranchExists`). Sequence becomes `fetch --prune origin` → (`checkout <branch>`
when a branch is requested) → `reset --hard origin/<branch>`. Deterministic,
no merge, no `FETCH_HEAD` ambiguity.

**Assumption:** `reset --hard` discards any local working-tree state in the checkout.
Correct here — these bot checkouts never hold local edits; publishing happens in
isolated worktrees.

### 4. Narrow retry (defense-in-depth)

Wrap the locked git sections with a bounded retry (3 attempts, small backoff) that
only retries on git lock-contention messages (`index.lock`, `cannot lock ref`,
`unable to create '*.lock'`). With the mutex + separated volumes this should rarely
fire; it guards residual/cross-process contention.

### 5. Infra: split the volume (`docker-compose.yml`)

- `api`: `magpie-api-checkouts:/data/checkouts`
- `watcher`: `magpie-watcher-checkouts:/data/checkouts`
- declare both named volumes.

(`docker-compose.watcher.yml` already uses a separate `watcher-checkouts` volume.)

## Testing (offline; inject the git runner, matching existing style)

- **Mutex unit tests:** same-key calls observe serial execution (no overlap);
  different-key calls overlap; a rejecting `fn` does not wedge later calls on that key.
- **`ensureGitCheckout`:** asserts the command sequence uses `fetch` + `reset --hard`
  and never `pull`; two concurrent calls on the same `localPath` do not interleave git
  commands (spy runner records ordering); different paths interleave.
- **Publisher:** existing tests pass unchanged; add a test that two concurrent
  `publish` calls to the same root serialize.
- **Retry:** a simulated lock-contention error retries and then succeeds; a
  non-lock error fails immediately.

## Non-goals

- Multi-replica cross-process locking (future Approach 2).
- Checkout-lifecycle refactor / ephemeral clones (Approach 3).
- The publication-outbox `done`-trap (separate issue).
- Operational recovery of already-stuck proposals (handled out-of-band by re-arming
  their publication actions; they drain once publishing stops failing).
