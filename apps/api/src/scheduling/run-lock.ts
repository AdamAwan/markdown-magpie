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
