import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrlFor, freshDatabaseName } from "./lib/test-db-target.mjs";

// Run a command against a single-use Postgres database that lives only for the
// duration of this run: migrate it from scratch, run the given command with
// DATABASE_URL pointed at it and RUN_PG_INTEGRATION=1 set (so the gated
// Postgres-backed integration tests actually run), then throw it away — so the
// tests never touch the dev database you use to run the app.
//
//   node scripts/test-db.mjs npm run test
//   node scripts/test-db.mjs npm run test:coverage
//
// Two ways to get that database:
//
//   * Docker (default): boot a throwaway pgvector container via Testcontainers
//     and stop it afterwards. Needs a Docker daemon, not a running Postgres.
//     Override the image with TEST_POSTGRES_IMAGE; it must ship pgvector because
//     migration 0001 creates the `vector` extension.
//
//   * Existing server: set TEST_DATABASE_ADMIN_URL to a superuser (or CREATEDB)
//     connection on a Postgres that has pgvector installed, e.g.
//       TEST_DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres
//     A fresh `magpie_test_<pid>_<random>` database is created for this run and
//     dropped (WITH FORCE) afterwards; nothing else on the server is touched.
//     This is what CI's Postgres service container and Docker-less machines use.

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const command = process.argv.slice(2);
if (command.length === 0) {
  command.push("npm", "run", "test");
}

let child;

// Best-effort: if we're interrupted, kill the child so the run unwinds into the
// finally block and the database is torn down instead of leaking.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child) {
      child.kill(signal);
    }
  });
}

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const target = adminUrl ? await freshDatabaseOn(adminUrl) : await throwawayContainer();

try {
  const childEnv = { ...process.env, DATABASE_URL: target.databaseUrl, RUN_PG_INTEGRATION: "1" };
  delete childEnv.TEST_DATABASE_ADMIN_URL;

  const migrateCode = await run("node", [path.join("scripts", "migrate.mjs")], childEnv);
  if (migrateCode !== 0) {
    process.exitCode = migrateCode;
  } else {
    const [bin, ...args] = command;
    process.exitCode = await run(bin, args, childEnv);
  }
} finally {
  await target.dispose();
}

async function throwawayContainer() {
  // Imported lazily so the existing-server mode works without Docker tooling.
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const image = process.env.TEST_POSTGRES_IMAGE || "pgvector/pgvector:pg16";
  console.log(`Starting throwaway Postgres container (${image})...`);
  const container = await new PostgreSqlContainer(image).withDatabase("markdown_magpie").start();
  console.log("Container ready");
  return {
    databaseUrl: container.getConnectionUri(),
    async dispose() {
      await container.stop();
      console.log("Stopped throwaway Postgres container");
    }
  };
}

async function freshDatabaseOn(serverAdminUrl) {
  const name = freshDatabaseName();
  const databaseUrl = databaseUrlFor(serverAdminUrl, name);
  await admin(serverAdminUrl, `CREATE DATABASE "${name}"`);
  console.log(`Created single-use database ${name}`);
  return {
    databaseUrl,
    async dispose() {
      // FORCE terminates any connection a crashed or still-draining child left
      // behind, so the drop never hangs on a straggler.
      await admin(serverAdminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      console.log(`Dropped single-use database ${name}`);
    }
  };
}

async function admin(serverAdminUrl, sql) {
  const client = new pg.Client({ connectionString: serverAdminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function run(bin, args, env) {
  return new Promise((resolve, reject) => {
    child = spawn(bin, args, { stdio: "inherit", cwd: rootDir, env, shell: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      child = undefined;
      resolve(code ?? 1);
    });
  });
}
