// Helpers for scripts that boot a self-contained Magpie stack as plain Node
// child processes (a deterministic provider fixture + the API + one watcher)
// against the single-use database scripts/test-db.mjs provides — no Docker
// image build. Shared by the golden eval (eval-golden.ts) and the CI queue e2e
// (e2e-jobs-local.ts).

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

// Env-var prefixes/names that could steer the pipeline: provider keys and base
// URLs, knowledge config, auth, embeddings, telemetry, ports. Stripped from a
// child's env so a developer's shell can never change what a run measures.
// DATABASE_URL (from test-db.mjs) is deliberately kept.
const STEERING_ENV =
  /^(OPENAI_COMPATIBLE_|AZURE_OPENAI_|KNOWLEDGE_|WATCHER_|FLOW_ROUTER_|GAP_|AI_|AUTH_|MAGPIE_|EMBEDDING_|OTEL_|LOG_|PORT$|API_BASE_URL$|SOURCE)/;

export function cleanEnv(overrides, base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (STEERING_ENV.test(key)) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("could not allocate a port")));
      }
    });
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `probe` until it resolves true; a throw counts as "not yet".
export async function waitFor(label, timeoutMs, probe, pollMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await probe()) {
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// A process group for one run: `launch` spawns a Node child whose stdout/stderr
// go to <logDir>/<name>.log; `stopAll` SIGTERMs every child still running.
export function createLauncher({ cwd, logDir, tag }) {
  mkdirSync(logDir, { recursive: true });
  const children = [];
  return {
    launch(name, args, env) {
      const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const logPath = path.join(logDir, `${name}.log`);
      writeFileSync(logPath, "");
      const append = (chunk) => appendFileSync(logPath, chunk);
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("exit", (code) => {
        if (code !== null && code !== 0) {
          console.error(`[${tag}] ${name} exited with code ${code} — see ${logPath}`);
        }
      });
      children.push(child);
      return child;
    },
    stopAll() {
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
        }
      }
    }
  };
}
