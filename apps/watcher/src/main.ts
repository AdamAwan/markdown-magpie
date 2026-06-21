import type { JobCapability } from "@magpie/jobs";
import { CAPABILITY_GATES } from "./capabilities.js";
import { HttpWatcherApi } from "./http-client.js";
import { createConfiguredRunners } from "./runners/index.js";
import { WorkerLoop } from "./worker-loop.js";

// Composition root for the watcher: build the API client and the runners the
// environment can support, advertise exactly those capabilities, and run the
// poll/execute loop until a shutdown signal. All job logic lives in the runners
// and the loop; this file only wires them together.

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const watcherName = process.env.WATCHER_NAME ?? "local-dev-watcher";
const pollIntervalMs = parsePositiveInt(process.env.WATCHER_POLL_INTERVAL_MS, 2000);

const api = new HttpWatcherApi({
  apiBaseUrl,
  workerName: watcherName,
  ...(process.env.API_TOKEN ? { apiToken: process.env.API_TOKEN } : {})
});

const runners = createConfiguredRunners(process.env, api);
// Advertise exactly the capabilities we have a runner for, so the broker never
// hands us a job we cannot execute.
const capabilities = [...new Set(runners.map((runner) => runner.capability))];

console.log(`Markdown Magpie watcher '${watcherName}' starting`);
console.log(`API: ${apiBaseUrl}`);
console.log(`Poll interval: ${pollIntervalMs}ms`);
logCapabilityReadiness(process.env);
console.log(`Advertised capabilities: ${capabilities.length ? capabilities.join(", ") : "(none)"}`);

if (capabilities.length === 0) {
  console.warn("No runner capabilities are configured; the watcher will idle. Configure a provider or GitHub credentials.");
}

const loop = new WorkerLoop(api, runners, capabilities, watcherName, { pollIntervalMs });

process.once("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  void loop.stop();
});
process.once("SIGINT", () => {
  console.log("Received SIGINT, shutting down...");
  void loop.stop();
});

await loop.run();
console.log(`Markdown Magpie watcher '${watcherName}' stopped`);

// Logs, per capability, whether each required env var is set or MISSING — never
// the secret values themselves — so a misconfiguration is visible at startup.
function logCapabilityReadiness(env: NodeJS.ProcessEnv): void {
  for (const gate of CAPABILITY_GATES) {
    if (gate.requiredEnv.length === 0) {
      console.log(`Capability ${pad(gate.capability)} — always available`);
      continue;
    }
    const states = gate.requiredEnv.map((name) => `${name}: ${env[name]?.trim() ? "set" : "MISSING"}`);
    console.log(`Capability ${pad(gate.capability)} — ${gate.ready(env) ? "ready" : "NOT ready"} (${states.join(", ")})`);
  }
}

function pad(capability: JobCapability): string {
  return capability.padEnd(18);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
