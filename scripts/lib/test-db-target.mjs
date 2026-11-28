// Pure helpers for scripts/test-db.mjs's no-Docker mode: given an admin URL to
// an existing Postgres server, derive a fresh single-use database name and the
// connection URL for it. Kept free of I/O so it is unit-testable
// (npm run test:scripts).

import { randomBytes } from "node:crypto";

// Every database test-db.mjs creates carries this prefix, so a leaked one (a
// SIGKILLed run that never reached its DROP) is easy to recognise and clean up.
export const TEST_DATABASE_PREFIX = "magpie_test_";

// A unique, identifier-safe database name: prefix + pid + random suffix. Only
// [a-z0-9_] so it can be interpolated into CREATE/DROP DATABASE as a quoted
// identifier without any escaping concerns.
export function freshDatabaseName(pid = process.pid, suffix = randomBytes(4).toString("hex")) {
  const name = `${TEST_DATABASE_PREFIX}${pid}_${suffix}`;
  assertSafeDatabaseName(name);
  return name;
}

export function assertSafeDatabaseName(name) {
  if (!/^[a-z0-9_]{1,63}$/.test(name)) {
    throw new Error(`unsafe test database name: ${JSON.stringify(name)}`);
  }
}

// The admin URL with its database path swapped for `databaseName`. Credentials,
// host, port and query parameters (e.g. sslmode) are kept as given.
export function databaseUrlFor(adminUrl, databaseName) {
  assertSafeDatabaseName(databaseName);
  let url;
  try {
    url = new URL(adminUrl);
  } catch {
    throw new Error("TEST_DATABASE_ADMIN_URL is not a valid postgres:// URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`TEST_DATABASE_ADMIN_URL must use postgres:// (got ${url.protocol})`);
  }
  url.pathname = `/${databaseName}`;
  return url.toString();
}
