import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JOB_TYPES } from "@magpie/jobs";
import { createQueueStatsReader } from "./queue-stats.js";

type Row = {
  kind: "queue" | "watchers" | "capability" | "schedule";
  k1: string | null;
  k2: string | null;
  a: number | null;
  b: number | null;
};

function fakePool(rows: Row[], ended = false) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    ended,
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return { rows };
    }
  };
}

describe("createQueueStatsReader", () => {
  it("runs one statement and folds fan-out queues into per-type rows, zero-filled", async () => {
    const pool = fakePool([
      { kind: "queue", k1: "answer_question__codex", k2: null, a: 2, b: 30 },
      { kind: "queue", k1: "answer_question__claude", k2: null, a: 1, b: 90 },
      { kind: "queue", k1: "answer_question__claude__dead_letter", k2: null, a: 4, b: 0 },
      { kind: "queue", k1: "not_a_catalog_queue", k2: null, a: 99, b: 999 },
      { kind: "watchers", k1: null, k2: null, a: 3, b: null },
      { kind: "capability", k1: "maintenance", k2: null, a: 3, b: null },
      { kind: "capability", k1: "codex", k2: null, a: 1, b: null },
      {
        kind: "schedule",
        // pg-boss stores schedule keys as magpie_<base64url(public key)>.
        k1: `magpie_${Buffer.from("task:correctness-patrol::docs").toString("base64url")}`,
        k2: "correctness_patrol",
        a: 120,
        b: null
      }
    ]);
    const read = createQueueStatsReader({ pool, pgBossSchema: "pgboss", watcherActiveWindowMs: 60_000 });
    const snapshot = await read();

    assert.equal(pool.calls.length, 1, "one grouped query per read");
    assert.match(pool.calls[0]!.sql, /"pgboss"\.job/);
    assert.equal(pool.calls[0]!.values[2], 60_000);
    assert.ok(snapshot);

    assert.equal(snapshot.jobTypes.length, JOB_TYPES.length, "every job type reports, idle ones as 0");
    const answer = snapshot.jobTypes.find((row) => row.jobType === "answer_question");
    // ready sums across provider queues; oldest is the max; dead letter is separate.
    assert.deepEqual(answer, { jobType: "answer_question", ready: 3, oldestReadyAgeSeconds: 90, deadLetter: 4 });
    const idle = snapshot.jobTypes.find((row) => row.jobType === "publish_proposal");
    assert.deepEqual(idle, { jobType: "publish_proposal", ready: 0, oldestReadyAgeSeconds: 0, deadLetter: 0 });

    assert.equal(snapshot.watchers.connected, 3);
    const capabilities = new Map(snapshot.watchers.byCapability.map((row) => [row.capability, row.connected]));
    assert.equal(capabilities.get("maintenance"), 3);
    assert.equal(capabilities.get("codex"), 1);
    assert.equal(capabilities.get("github"), 0, "catalog capabilities with no watcher report 0");

    assert.deepEqual(snapshot.schedules, [
      { key: "task:correctness-patrol::docs", jobType: "correctness_patrol", lastSuccessAgeSeconds: 120 }
    ]);
  });

  it("reports nothing and does not query once the pool has ended", async () => {
    const pool = fakePool([], true);
    const read = createQueueStatsReader({ pool, pgBossSchema: "pgboss", watcherActiveWindowMs: 1 });
    assert.equal(await read(), undefined);
    assert.equal(pool.calls.length, 0);
  });

  it("rejects a schema name that is not a plain identifier", () => {
    assert.throws(
      () => createQueueStatsReader({ pool: fakePool([]), pgBossSchema: 'x"; DROP', watcherActiveWindowMs: 1 }),
      /Invalid pg-boss schema/
    );
  });
});
