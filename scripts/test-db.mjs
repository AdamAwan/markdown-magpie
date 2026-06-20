import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

// Run a command against a single-use Postgres database that lives only for the
// duration of this run. We boot a throwaway pgvector container, migrate it, run
// the given command with DATABASE_URL pointed at it, then tear it down — so the
// integration tests never touch the dev database you use to run the app, and a
// running Postgres server isn't required at all (just a Docker daemon).
//
//   node scripts/test-db.mjs npm run test
//   node scripts/test-db.mjs npm run test:coverage
//
// Override the image with TEST_POSTGRES_IMAGE if needed; it must ship pgvector
// because migration 0001 creates the `vector` extension.

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.TEST_POSTGRES_IMAGE || "pgvector/pgvector:pg16";

const command = process.argv.slice(2);
if (command.length === 0) {
  command.push("npm", "run", "test");
}

let container;
let child;

// Best-effort: if we're interrupted, kill the child so the run unwinds into the
// finally block and the container is torn down instead of leaking.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child) {
      child.kill(signal);
    }
  });
}

try {
  console.log(`Starting throwaway Postgres container (${image})...`);
  container = await new PostgreSqlContainer(image).withDatabase("markdown_magpie").start();
  const databaseUrl = container.getConnectionUri();
  console.log("Container ready");

  const childEnv = { ...process.env, DATABASE_URL: databaseUrl };

  const migrateCode = await run("node", [path.join("scripts", "migrate.mjs")], childEnv);
  if (migrateCode !== 0) {
    process.exitCode = migrateCode;
  } else {
    const [bin, ...args] = command;
    process.exitCode = await run(bin, args, childEnv);
  }
} finally {
  if (container) {
    await container.stop();
    console.log("Stopped throwaway Postgres container");
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
