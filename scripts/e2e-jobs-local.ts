/**
 * Self-contained runner for the queue-lifecycle e2e (scripts/e2e-jobs.ts).
 *
 * e2e-jobs.ts drives an already-running stack. This wrapper boots one for it,
 * as plain Node processes (no image build), against the single-use Postgres
 * that scripts/test-db.mjs provides:
 *
 *   - the deterministic OpenAI-compatible chat fixture
 *     (scripts/fixtures/openai-fixture.mjs — honours the [slow] / [fail]
 *     markers the cancel and retry scenarios rely on),
 *   - the API (auth off, Postgres storage, strict job-output policy),
 *   - one watcher pointed at the fixture,
 *
 * with one flow over a small fixture KB so the ask path routes, retrieves and
 * the listing scenario has a per-flow scheduled task to enable. It then runs
 * e2e-jobs.ts against that API and exits with its status. No provider keys:
 * every model call is answered by the fixture.
 *
 * Run it:   npm run e2e:jobs:local      (wraps this in test-db.mjs)
 * Logs:     .magpie/e2e-jobs/{openai-fixture,api,watcher}.log
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv, createLauncher, freePort, waitFor } from "./lib/local-stack.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(rootDir, "scripts", "fixtures");
const kbDir = path.join(fixturesDir, "golden-kb", "aurora");
const stateDir = path.join(rootDir, ".magpie", "e2e-jobs");
const BOOT_TIMEOUT_MS = 90_000;

const stack = createLauncher({ cwd: rootDir, logDir: stateDir, tag: "e2e" });

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Run via `npm run e2e:jobs:local` (scripts/test-db.mjs provides the single-use database)."
    );
  }
  const checkoutRoot = path.join(stateDir, "checkouts");
  mkdirSync(checkoutRoot, { recursive: true });

  const fixturePort = await freePort();
  const apiPort = await freePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;

  stack.launch(
    "openai-fixture",
    [path.join(fixturesDir, "openai-fixture.mjs")],
    // Long enough for the cancel scenario to land while the answer call is in
    // flight (the fixture's sleep is interruptible, so a cancel short-circuits it).
    cleanEnv({ FIXTURE_PORT: String(fixturePort), FIXTURE_SLOW_DELAY_MS: "20000" })
  );
  await waitFor("chat fixture health", BOOT_TIMEOUT_MS, async () => {
    const response = await fetch(`http://127.0.0.1:${fixturePort}/health`);
    return response.ok;
  });

  stack.launch(
    "api",
    ["--import", "tsx", path.join(rootDir, "apps", "api", "src", "main.ts")],
    cleanEnv({
      DATABASE_URL: databaseUrl,
      PORT: String(apiPort),
      AUTH_REQUIRED: "false",
      // Strict job-output policy, as in the compose e2e stack (docs/ai-jobs.md J24).
      MAGPIE_JOB_OUTPUT_STRICT: "true",
      // One anonymous client: the rate limiter would only add noise here.
      RATE_LIMIT_ENABLED: "false",
      STORAGE_BACKEND: "postgres",
      KNOWLEDGE_STORE: "postgres",
      AI_PROVIDER: "openai-compatible",
      MAGPIE_CHECKOUT_ROOT: checkoutRoot,
      KNOWLEDGE_SOURCES: JSON.stringify([{ id: "docs-src", name: "Docs Source", path: kbDir }]),
      KNOWLEDGE_DESTINATIONS: JSON.stringify([{ id: "docs-kb", name: "Docs", path: kbDir }]),
      KNOWLEDGE_FLOWS: JSON.stringify([
        { id: "docs", name: "Docs", sourceIds: ["docs-src"], destinationId: "docs-kb", persona: "Product docs." }
      ]),
      LOG_LEVEL: "warn"
    })
  );
  await waitFor("API health", BOOT_TIMEOUT_MS, async () => {
    const response = await fetch(`${apiBase}/api/health`);
    return response.ok;
  });
  const indexed = await fetch(`${apiBase}/api/knowledge/repositories/index`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId: "docs" })
  });
  if (!indexed.ok) {
    throw new Error(`indexing the fixture KB failed: ${indexed.status} ${await indexed.text()}`);
  }

  stack.launch(
    "watcher",
    ["--import", "tsx", path.join(rootDir, "apps", "watcher", "src", "main.ts")],
    cleanEnv({
      API_BASE_URL: apiBase,
      AUTH_REQUIRED: "false",
      AI_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${fixturePort}/v1`,
      OPENAI_COMPATIBLE_API_KEY: "fixture",
      OPENAI_COMPATIBLE_MODEL: "fixture",
      MAGPIE_CHECKOUT_ROOT: checkoutRoot,
      MAGPIE_JOB_OUTPUT_STRICT: "true",
      WATCHER_POLL_INTERVAL_MS: "250",
      // Its own health port, so a dev watcher on the default 4002 never collides.
      WATCHER_HEALTH_PORT: String(await freePort()),
      LOG_LEVEL: "warn"
    })
  );
  await waitFor("watcher registration", BOOT_TIMEOUT_MS, async () => {
    const response = await fetch(`${apiBase}/api/workers`);
    const body = (await response.json()) as { workers?: unknown[] };
    return Array.isArray(body.workers) && body.workers.length > 0;
  });
  console.log(`[e2e] stack up (API ${apiBase}, fixture :${fixturePort}) — running scripts/e2e-jobs.ts`);

  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(rootDir, "scripts", "e2e-jobs.ts")], {
      cwd: rootDir,
      stdio: "inherit",
      env: cleanEnv({ E2E_API_BASE_URL: apiBase })
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("[e2e] queue e2e failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    stack.stopAll();
  });
