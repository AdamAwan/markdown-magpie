import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { createDbPool } from "./db-pool.js";

const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/markdown_magpie";

function poolConfig(connectionString: string) {
  return {
    databaseUrl: connectionString,
    database: { poolMax: 4, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000, statementTimeoutMs: 30_000 }
  };
}

// Resolves once the client's connection has ended — after its "error" event
// fired (and was survived).
function nextEnd(client: pg.PoolClient): Promise<void> {
  return new Promise((resolve) => client.once("end", () => resolve()));
}

describe("createDbPool", () => {
  it("survives an idle-connection error event instead of throwing it", async () => {
    // No query is ever issued, so this never touches a database.
    const pool = createDbPool(poolConfig("postgres://unused@127.0.0.1:1/unused"));
    try {
      // An EventEmitter "error" with no listener throws synchronously.
      assert.doesNotThrow(() => pool.emit("error", new Error("terminating connection due to administrator command")));
    } finally {
      await pool.end();
    }
  });

  it(
    "survives Postgres terminating both an idle and a checked-out connection",
    // A missing handler fails the test with an uncaught exception; the timeout
    // keeps that from also hanging the run on the never-ending pool.
    { skip: !runIntegration, timeout: 15_000 },
    async () => {
      const pool = createDbPool(poolConfig(databaseUrl));
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      try {
        // A checked-out client (like a held advisory-lock connection) and an idle
        // one, each on its own backend.
        const held = await pool.connect();
        const idle = await pool.connect();
        const heldPid = (await held.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const idlePid = (await idle.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        idle.release();

        // Wait on "end", not "error": a test listener on "error" would itself
        // absorb the event and hide a missing handler. pg emits "error" before
        // "end", so without createDbPool's handlers the unhandled "error" throws
        // out of the socket callback and fails this test as an uncaught exception.
        const heldEnded = nextEnd(held);
        const idleEnded = nextEnd(idle);
        // What a Postgres restart does to every backend.
        await admin.query("SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid", [[heldPid, idlePid]]);
        await Promise.all([heldEnded, idleEnded]);
        held.release(true);

        // The pool recovers on its own: the next checkout opens a fresh backend.
        const fresh = await pool.query<{ ok: number }>("SELECT 1 AS ok");
        assert.equal(fresh.rows[0].ok, 1);
      } finally {
        await admin.end();
        await pool.end();
      }
    }
  );
});
