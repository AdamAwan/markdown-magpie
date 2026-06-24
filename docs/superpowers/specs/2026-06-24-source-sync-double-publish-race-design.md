# Source-sync double-publish race fix — design

**Status:** Approved · **Date:** 2026-06-24 · **Author:** Adam

A carry-over bug from PR #25 (source-sync through the reconcile gate, Scope A). The
re-gate path can enqueue a redundant `publish_source_sync` job when two source-sync
ticks interleave. Never lossy; wasteful and confusing. This is a small, contained fix.

---

## 1. The bug

`regateDeferredRuns` (`apps/api/src/features/source-sync/service.ts`) re-checks each
deferred run on every tick and, once the run's overlap clears, completes it and
enqueues publication:

```js
await ctx.stores.sourceSync.completeDeferredRun(run.id);
await enqueuePublication(ctx, run.id);   // ← runs unconditionally
```

Two ticks can run concurrently — a manual `POST /api/source-sync/run` landing on top
of the scheduled tick. Both call `listDeferredRuns` and capture the same still-
`deferred` run *before* either completes it. `completeDeferredRun`'s status guard means
only one call actually transitions `deferred → completed`, but **both** callers then
call `enqueuePublication`. Result: two `publish_source_sync` jobs for one run.

The downstream publish completion handler (`recordSourceSyncPublicationFromCompletedJob`)
is idempotent by `runId`, so nothing is lost or double-applied — but the second job is
wasted work and muddies the run/job history.

### Root cause

`completeDeferredRun` cannot tell its caller *whether this call performed the
transition*. Both stores return the completed run regardless:

- In-memory: returns `existing` (the already-completed run) on a non-deferred run.
- Postgres: `UPDATE … WHERE status='deferred' RETURNING *` returns no row on no-match,
  but the method falls back to `this.getRun(id)`, so the caller still sees the run.

The caller therefore cannot distinguish "I completed it" from "it was already
completed by the other tick", and publishes either way.

## 2. The fix

**Change `completeDeferredRun` to return the run only when *this* call performed the
`deferred → completed` transition; `undefined` otherwise** (run not found, or already
non-deferred). The caller gates publication on a defined result.

### Store: in-memory (`source-sync-store.ts`)

Return `undefined` instead of `existing` when the run is not `deferred`:

```js
async completeDeferredRun(id: string): Promise<SourceSyncRun | undefined> {
  const existing = this.runs.get(id);
  if (!existing || existing.status !== "deferred") {
    return undefined; // not found or already completed — this call did nothing
  }
  const updated: SourceSyncRun = { ...existing, status: "completed", completedAt: new Date().toISOString() };
  this.runs.set(id, updated);
  return updated;
}
```

The read-check-write is synchronous (no `await` between), so it is atomic under the
single-threaded event loop: exactly one of two interleaved callers sees `deferred`.

### Store: Postgres (`postgres-source-sync-store.ts`)

Drop the `: this.getRun(id)` fallback so a no-match returns `undefined`:

```js
async completeDeferredRun(id: string): Promise<SourceSyncRun | undefined> {
  // deferred → completed. The conditional UPDATE is the synchronization point:
  // exactly one of two racing re-gates matches a row and gets it back. A no-match
  // (already completed / not found) returns undefined so the caller publishes once.
  const result = await this.pool.query<SourceSyncRunRow>(
    "UPDATE source_sync_runs SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'deferred' RETURNING *",
    [id]
  );
  return result.rows[0] ? mapRunRow(result.rows[0]) : undefined;
}
```

The DB performs the arbitration: only the row-matching UPDATE returns a row.

### Store interface doc (`source-sync-store.ts`)

Update the `completeDeferredRun` doc comment to state the new contract: returns the
run only when this call effected the transition; `undefined` if not found or already
non-deferred. Callers gate publication on a defined result.

### Caller (`regateDeferredRuns` in `service.ts`)

```js
const completed = await ctx.stores.sourceSync.completeDeferredRun(run.id);
if (!completed) {
  continue; // a concurrent re-gate already completed (and will publish) this run
}
await enqueuePublication(ctx, run.id);
console.log(`Source-sync re-gate: deferred run ${run.id} overlap cleared; enqueued publication.`);
```

## 3. Contract change

`completeDeferredRun` is called only from `regateDeferredRuns`, which currently ignores
its return value, so this is a safe, localised contract change. It deliberately
diverges from the sibling `transitionFromRunning`-based methods (which return the
unchanged row on a no-op): `completeDeferredRun` is the only transition whose caller
has a publish side-effect keyed on *who* won the transition, so its return must carry
that signal.

## 4. Out of scope

The analogous `completeRun` + unconditional `enqueuePublication` in
`attachSourceSyncPlanFromCompletedJob` is **not** changed. That path is guarded by a
`status === "running"` check at function entry and is driven by single job-completion
delivery, not the concurrent-tick race. The PR #25 opus review flagged only the
re-gate path.

No schema or migration change: the fix is pure logic on existing columns/state.

## 5. Testing

1. **Store contract (deterministic regression guard)** —
   `apps/api/src/stores/source-sync-store.test.ts`: create a deferred run; the first
   `completeDeferredRun` returns the run with `status: "completed"`; a second
   `completeDeferredRun` on the same id returns `undefined`. Also: `completeDeferredRun`
   on an unknown id returns `undefined`. Fails before the fix (second call returns the
   completed run), passes after.

2. **Orchestration (integration guard)** —
   `apps/api/src/features/source-sync/orchestration.test.ts`: defer a run (overlapping
   open proposal), clear the overlap (merge the proposal), then fire **two**
   `triggerSourceSyncRun` ticks concurrently via `Promise.all`. Assert exactly **one**
   `publish_source_sync` job is enqueued and the run ends `completed`. The interleave
   reliably reproduces the bug pre-fix: both ticks read the deferred run from
   `listDeferredRuns` before either completes it, so both reach `completeDeferredRun`;
   pre-fix both then publish, post-fix only the winner does.

## 6. Known limitations

- The in-memory atomicity relies on `completeDeferredRun` having no `await` between its
  read and write. The implementation keeps it synchronous; a future refactor that
  introduces an await inside would reopen the window for that store (Postgres remains
  safe via the conditional UPDATE). Noted, not guarded.
