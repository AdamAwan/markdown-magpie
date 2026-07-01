import pg from "pg";
import type { AppConfig } from "./config.js";

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
// two are intentionally separate and not double-counted.
export function createDbPool(config: AppConfig): pg.Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.database.poolMax,
    idleTimeoutMillis: config.database.idleTimeoutMs,
    connectionTimeoutMillis: config.database.connectionTimeoutMs,
    // Server-side cap: any single statement exceeding this is aborted by
    // Postgres, releasing the connection back to the pool instead of leaking it.
    statement_timeout: config.database.statementTimeoutMs
  });
}
