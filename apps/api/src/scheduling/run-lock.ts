// Serializes a per-flow maintenance run across every API instance sharing this
// database, using a Postgres SESSION-level advisory lock.
//
// Why this exists (issue #167): pg-boss dedupes the reconciler *enqueue* per cron
// slot (the timekeeper sends with a singletonKey/singletonSeconds), but it does
// NOT serialize *execution* — the maintenance queues are standard-policy, so the
// T+0 job can still be active when the T+10 slot's job is claimed by a second
// watcher. Both watchers then POST /api/gaps/reconcile and run reconcileGaps for
// the same flow concurrently, doubling every metered reshape + draft generation.
// The isTaskRunning guard only covers the manual "Run now" enqueue, not the cron
// path and not execution overlap.
//
// This lock lives at the single execution site both paths funnel through
// (reconcileGaps), so it covers cron AND manual fires with one mechanism. It is
// multi-instance-safe by construction: pg_try_advisory_lock is held in Postgres,
// not process memory, so it serializes across API replicas, not just within one
// process. The key is (taskType, flowId), so distinct flows still reconcile in
// parallel — preserving the scheduler's per-flow independence — while the same
// flow runs one at a time. A session-level lock auto-releases if the holding
// connection dies, so a crashed run never leaves the flow wedged.

// Narrow structural subsets of node-postgres' Pool/PoolClient: enough to take and
// release the lock, and satisfied by the real `pg.Pool` unchanged, so a test can
// inject a fake without a live database and without casting through `unknown`.
export interface RunLockClient {
  query<Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }>;
  release(): void;
}
export interface RunLockPool {
  connect(): Promise<RunLockClient>;
  // node-postgres exposes the pool's configuration here; only `max` is read, to
  // bound how many waiting-lock holders may pin a connection at once (see
  // withFlowRunLockWaiting). Optional so a test fake need not supply it.
  options?: { max?: number };
}

// The outcome of a guarded run: `acquired: false` means another holder is running
// this flow's task, so `run` was NOT invoked and the caller should skip quietly.
export type RunLockResult<T> = { acquired: true; value: T } | { acquired: false };

// Runs `run` while holding the (taskType, flowId) advisory lock, releasing it
// afterwards. When the lock is already held elsewhere, `run` is skipped and
// `{ acquired: false }` is returned. When `pool` is undefined (in-memory/unit-test
// wiring — a single process with no replica to race), `run` executes unlocked.
export async function withFlowRunLock<T>(
  pool: RunLockPool | undefined,
  taskType: string,
  flowId: string | undefined,
  run: () => Promise<T>
): Promise<RunLockResult<T>> {
  if (!pool) {
    return { acquired: true, value: await run() };
  }
  // hashtextextended maps the composite key to the bigint the advisory-lock
  // functions take, so no hand-maintained numeric key registry is needed. The two
  // key axes are joined with a separator flow ids (slugs) can't contain, so no two
  // (taskType, flowId) pairs collide onto one key.
  const key = `${taskType} ${flowId ?? ""}`;
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [key]
    );
    if (!rows[0]?.locked) {
      return { acquired: false };
    }
    try {
      return { acquired: true, value: await run() };
    } finally {
      // Release on the same connection that took the lock, with the same key.
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    }
  } finally {
    client.release();
  }
}

// Thrown by withFlowRunLockWaiting when the lock stayed held past the deadline.
// Deliberately an error, not a skip: the caller is a CONTINUATION whose work
// would otherwise be silently dropped. From a job-completion handler it surfaces
// as side_effects_failed → HTTP 500 → the watcher re-POSTs the completion and the
// replay retries the continuation (see completeJob).
export class RunLockTimeoutError extends Error {
  constructor(taskType: string, flowId: string | undefined) {
    super(`timed out waiting for the ${taskType} run lock (${flowId ?? "default"})`);
    this.name = "RunLockTimeoutError";
  }
}

// Like withFlowRunLock, but for a caller that must not skip: it retries the
// try-lock until it is acquired (or `timeoutMs` elapses, which throws). Used by
// the completion-side continuations of the non-blocking orchestrators, which
// serialise against the orchestrator's own tick and against each other —
// skipping would lose the follow-up job's outcome.
//
// It polls pg_try_advisory_lock rather than blocking on pg_advisory_lock on
// purpose: a blocked waiter would pin a pooled connection for the whole wait, and
// the lock HOLDER needs pool connections to do its work — enough simultaneous
// waiters (many re-asks of one proposal completing at once) would starve the
// holder and deadlock the pool. Polling holds a connection only for the instant
// of each attempt.
//
// The default deadline sits BELOW the watcher's 30s request timeout on purpose:
// a continuation that cannot get the lock should answer the completion POST with
// a clean 500 (which the watcher retries) rather than be abandoned mid-wait by a
// client-side abort.
const DEFAULT_LOCK_WAIT_MS = 20_000;

export async function withFlowRunLockWaiting<T>(
  pool: RunLockPool | undefined,
  taskType: string,
  flowId: string | undefined,
  run: () => Promise<T>,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOCK_WAIT_MS);
  const pollMs = options.pollMs ?? 100;
  while (true) {
    // A holder pins one pooled connection for its whole run (a session-level
    // advisory lock lives on the connection that took it) AND needs further
    // connections from the same pool to do its work. If as many continuations as
    // the pool has connections held a lock at once, none could run a query: each
    // would wait on the pool until its connection timeout. So at most half the
    // pool may be pinned by holders; a continuation beyond that waits its turn
    // here, holding nothing, exactly as if its lock were taken.
    if (tryEnterHolder(pool)) {
      try {
        const result = await withFlowRunLock(pool, taskType, flowId, run);
        if (result.acquired) {
          return result.value;
        }
      } finally {
        leaveHolder(pool);
      }
    }
    if (Date.now() >= deadline) {
      throw new RunLockTimeoutError(taskType, flowId);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// node-postgres' default pool size, used when a pool does not say.
const DEFAULT_POOL_MAX = 10;

// How many waiting-lock holders are currently inside each pool. Per process,
// which is the right scope: the pool being protected is per process too.
const holdersByPool = new WeakMap<RunLockPool, number>();

function tryEnterHolder(pool: RunLockPool | undefined): boolean {
  if (!pool) {
    return true;
  }
  const limit = Math.max(1, Math.floor((pool.options?.max ?? DEFAULT_POOL_MAX) / 2));
  const holders = holdersByPool.get(pool) ?? 0;
  if (holders >= limit) {
    return false;
  }
  holdersByPool.set(pool, holders + 1);
  return true;
}

function leaveHolder(pool: RunLockPool | undefined): void {
  if (pool) {
    holdersByPool.set(pool, Math.max(0, (holdersByPool.get(pool) ?? 1) - 1));
  }
}
