import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Run a command against a throwaway Postgres database that exists only for the
// duration of this run. We create a freshly-named database on the same server
// the rest of the project uses, migrate it, run the given command with
// DATABASE_URL pointed at it, then drop it — so the integration tests never
// touch the dev database you use to run the app (markdown_magpie).
//
//   node scripts/test-db.mjs npm run test
//   node scripts/test-db.mjs npm run test:coverage
//
// The server/credentials come from TEST_DATABASE_URL, else DATABASE_URL (read
// from .env), else a localhost default. Only the database *name* is swapped for
// the ephemeral one — everything else (host, port, user, password) is reused.

const { Client } = pg;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await loadEnvFile(path.join(rootDir, ".env"));

const baseUrl =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/postgres";

// A unique, valid identifier so parallel/repeated runs never collide and a
// crashed run leaves an obviously-orphaned database rather than corrupting one.
const dbName = `magpie_test_${Date.now()}_${process.pid}`;

const adminUrl = withDatabase(baseUrl, "postgres");
const ephemeralUrl = withDatabase(baseUrl, dbName);

const command = process.argv.slice(2);
if (command.length === 0) {
  command.push("npm", "run", "test");
}

let createdDatabase = false;
let child;

// Best-effort: if we're interrupted, kill the child so the run unwinds into the
// finally block and drops the database instead of leaking it.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child) {
      child.kill(signal);
    }
  });
}

try {
  await runAdmin(`CREATE DATABASE "${dbName}"`);
  createdDatabase = true;
  console.log(`Created throwaway test database ${dbName}`);

  const childEnv = { ...process.env, DATABASE_URL: ephemeralUrl };

  const migrateCode = await run("node", [path.join("scripts", "migrate.mjs")], childEnv);
  if (migrateCode !== 0) {
    process.exitCode = migrateCode;
  } else {
    const [bin, ...args] = command;
    process.exitCode = await run(bin, args, childEnv);
  }
} finally {
  if (createdDatabase) {
    // FORCE (pg 13+) terminates any stragglers so the drop can't hang on a
    // connection the test process left dangling.
    await runAdmin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    console.log(`Dropped throwaway test database ${dbName}`);
  }
}

function withDatabase(connectionString, database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

async function runAdmin(sql) {
  const client = new Client({ connectionString: adminUrl });
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

async function loadEnvFile(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = parseEnvValue(trimmed.slice(separatorIndex + 1).trim());
    if (!key || Object.hasOwn(process.env, key)) {
      continue;
    }

    process.env[key] = value;
  }
}

function parseEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
