import pg from "pg";
import type { AppConfig } from "./config.js";
import { logger } from "../logger.js";

const { Pool } = pg;

// One process-wide Postgres connection pool, shared by every Postgres-backed
// store. Previously each of ~12 stores created its own untuned `new Pool`, so a
// single API instance could open ~12 × pg-default-10 = ~120 connections and
// exhaust the server. Constructing the pool once here — with explicit tunables
// from validated config and a server-side statement_timeout so a hung query
// can't pin a connection forever — keeps the footprint bounded and observable.
//
// pg-boss owns its OWN pool internally (it needs LISTEN/NOTIFY and long-lived
// maintenance connections); this pool is for the application stores only, so the
// two are intentionally separate and not double-counted. pg-boss forwards its
// pool's errors to its own "error" event, which the broker already logs.
export function createDbPool(config: Pick<AppConfig, "databaseUrl" | "database">): pg.Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.database.poolMax,
    idleTimeoutMillis: config.database.idleTimeoutMs,
    connectionTimeoutMillis: config.database.connectionTimeoutMs,
    // Server-side cap: any single statement exceeding this is aborted by
    // Postgres, releasing the connection back to the pool instead of leaking it.
    statement_timeout: config.database.statementTimeoutMs
  });
  attachConnectionErrorHandlers(pool);
  return pool;
}

// A Postgres restart (or failover, or an idle connection reaped by a proxy)
// terminates every open backend, and node-postgres reports each one as an
// "error" EVENT — on the pool for an idle client, on the client itself for one
// that is checked out. An EventEmitter "error" with no listener is thrown, so
// without these handlers a routine database restart crashed the whole API
// (docs/api.md API26). Either way the connection is already unusable: pg-pool
// discards a failed idle client by itself, and a checked-out client's in-flight
// query rejects to its caller, who releases it. So the right response is to log
// and carry on — the next checkout opens a fresh connection once Postgres is
// back, and /api/ready reports the outage meanwhile.
function attachConnectionErrorHandlers(pool: pg.Pool): void {
  pool.on("error", (error) => {
    logger.error({ err: error.message }, "postgres pool: idle connection failed (discarded)");
  });
  // "connect" fires once per newly-opened client, so each client carries exactly
  // one permanent listener for its whole life, idle or checked out. The pool's own
  // idle listener still runs alongside it to evict the client.
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      logger.warn({ err: error.message }, "postgres pool: connection error");
    });
  });
}
