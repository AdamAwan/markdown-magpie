import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { withFlowRunLock, type RunLockClient, type RunLockPool } from "./run-lock.js";

// A fake pool/client that simulates pg_try_advisory_lock: the first live holder of
// a key succeeds, and any concurrent acquire of the same key fails until the holder
// unlocks — exactly the semantics a real Postgres session-level advisory lock gives
// across API instances. Records the sequence of lock/unlock calls for assertions.
class FakeAdvisoryPool implements RunLockPool {
  readonly held = new Set<string>();
  readonly events: string[] = [];
  released = 0;

  // Arrow-bound field (not a method) so the client closures below capture the
  // instance via lexical `this`, without aliasing it to a local.
  connect = async (): Promise<RunLockClient> => {
    // Each connection tracks the key it holds, so release can't drop someone else's.
    let ownKey: string | undefined;
    return {
      query: async <Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }> => {
        const key = String(values[0]);
        if (text.includes("pg_try_advisory_lock")) {
          const locked = !this.held.has(key);
          if (locked) {
            this.held.add(key);
            ownKey = key;
          }
          this.events.push(`try:${key}:${locked}`);
          return { rows: [{ locked } as Row] };
        }
        // pg_advisory_unlock
        this.held.delete(key);
        ownKey = undefined;
        this.events.push(`unlock:${key}`);
        return { rows: [{ unlocked: true } as Row] };
      },
      release: (): void => {
        this.released += 1;
        // A real session-level lock auto-releases on disconnect; mirror that so a
        // run that forgot to unlock still frees the key when the client is released.
        if (ownKey) {
          this.held.delete(ownKey);
        }
      }
    };
  };
}

describe("withFlowRunLock", () => {
  it("runs the body under the lock and releases it afterwards", async () => {
    const pool = new FakeAdvisoryPool();
    let ran = 0;
    const result = await withFlowRunLock(pool, "process_gaps_to_pull_requests", "flow-a", async () => {
      assert.equal(pool.held.size, 1, "the lock is held while the body runs");
      ran += 1;
      return "value";
    });
    assert.deepEqual(result, { acquired: true, value: "value" });
    assert.equal(ran, 1);
    assert.equal(pool.held.size, 0, "the lock is released after the run");
    assert.equal(pool.released, 1, "the pooled connection is returned");
  });

  it("skips the body when the same flow's lock is already held (overlap protection)", async () => {
    const pool = new FakeAdvisoryPool();
    let firstStarted!: () => void;
    const firstRunning = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const finishFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let firstRan = 0;
    let secondRan = 0;
    // The first run holds the lock and parks until we let it finish.
    const first = withFlowRunLock(pool, "process_gaps_to_pull_requests", "flow-a", async () => {
      firstRan += 1;
      firstStarted();
      await finishFirst;
    });
    await firstRunning;

    // A concurrent, overlapping run for the SAME flow must not execute its body.
    const second = await withFlowRunLock(pool, "process_gaps_to_pull_requests", "flow-a", async () => {
      secondRan += 1;
    });
    assert.deepEqual(second, { acquired: false }, "the overlapping run is refused the lock");
    assert.equal(secondRan, 0, "the overlapping run's work never executes — no double reshape/draft");

    releaseFirst();
    assert.deepEqual(await first, { acquired: true, value: undefined });
    assert.equal(firstRan, 1);
    assert.equal(pool.held.size, 0, "the lock is free once the first run completes");
  });

  it("lets a different flow reconcile in parallel (per-flow key, not global)", async () => {
    const pool = new FakeAdvisoryPool();
    let releaseA!: () => void;
    const finishA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const a = withFlowRunLock(pool, "process_gaps_to_pull_requests", "flow-a", async () => {
      await finishA;
    });
    // flow-b acquires immediately even while flow-a still holds its own lock.
    let bRan = 0;
    const b = await withFlowRunLock(pool, "process_gaps_to_pull_requests", "flow-b", async () => {
      bRan += 1;
    });
    assert.deepEqual(b, { acquired: true, value: undefined }, "a distinct flow is not blocked");
    assert.equal(bRan, 1);
    releaseA();
    await a;
  });

  it("releases the lock even when the body throws, then rethrows", async () => {
    const pool = new FakeAdvisoryPool();
    await assert.rejects(
      () =>
        withFlowRunLock(pool, "process_gaps_to_pull_requests", "flow-a", async () => {
          throw new Error("boom");
        }),
      /boom/
    );
    assert.equal(pool.held.size, 0, "a thrown body still frees the lock");
    assert.equal(pool.released, 1, "and returns the connection");
    assert.deepEqual(pool.events, ["try:process_gaps_to_pull_requests flow-a:true", "unlock:process_gaps_to_pull_requests flow-a"]);
  });

  it("runs unlocked when there is no pool (in-memory/unit wiring)", async () => {
    let ran = 0;
    const result = await withFlowRunLock(undefined, "process_gaps_to_pull_requests", "flow-a", async () => {
      ran += 1;
      return 7;
    });
    assert.deepEqual(result, { acquired: true, value: 7 });
    assert.equal(ran, 1);
  });
});

// Real-Postgres proof that the advisory-lock SQL serializes across *connections*
// (i.e. across API instances), not just within one process. Gated behind
// RUN_PG_INTEGRATION so `npm test` stays DB-free; run via `npm run test:db`.
const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/markdown_magpie";

test("withFlowRunLock serializes the same flow across two real Postgres connections", { skip: !runIntegration }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    let releaseFirst!: () => void;
    const finishFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondRan = 0;

    // First holder parks while holding the lock on its own connection.
    const first = withFlowRunLock(pool, "process_gaps_to_pull_requests", "flow-int", async () => {
      // A concurrent acquire of the SAME flow (a second connection) must be refused.
      const overlap = await withFlowRunLock(pool, "process_gaps_to_pull_requests", "flow-int", async () => {
        secondRan += 1;
      });
      assert.deepEqual(overlap, { acquired: false }, "the second connection is refused the held lock");
      // A DIFFERENT flow is not blocked, even while flow-int is held.
      let otherRan = 0;
      const other = await withFlowRunLock(pool, "process_gaps_to_pull_requests", "flow-other", async () => {
        otherRan += 1;
      });
      assert.deepEqual(other, { acquired: true, value: undefined }, "a distinct flow acquires in parallel");
      assert.equal(otherRan, 1);
      releaseFirst();
      await finishFirst;
    });

    assert.deepEqual(await first, { acquired: true, value: undefined });
    assert.equal(secondRan, 0, "the overlapping run's body never executed");

    // Once released, the flow is acquirable again.
    const reacquire = await withFlowRunLock(pool, "process_gaps_to_pull_requests", "flow-int", async () => "ok");
    assert.deepEqual(reacquire, { acquired: true, value: "ok" });
  } finally {
    await pool.end();
  }
});
