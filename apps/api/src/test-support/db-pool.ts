import pg from "pg";

const { Pool } = pg;

// Postgres-backed stores now take a shared pool instead of a connection string.
// Integration tests use this helper to build one from DATABASE_URL so they keep
// exercising real SQL after the shared-pool refactor.
export function makeTestPool(connectionString: string): pg.Pool {
  return new Pool({ connectionString });
}
