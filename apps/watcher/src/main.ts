import { randomUUID } from "node:crypto";
import { createApiTokenProvider } from "@magpie/auth";
import { hydrateGithubTokenFromGhCli } from "@magpie/git";
import { installCrashHandlers } from "@magpie/logger";
import { initTelemetry, type TelemetryHandle } from "@magpie/telemetry";
import type { JobCapability } from "@magpie/jobs";
import {
  CAPABILITY_GATES,
  DEFAULT_CAPABILITY_RUNTIME,
  deriveCapabilities,
  type CapabilityRuntime
} from "./capabilities.js";
import { loadWatcherConfig } from "./config.js";
import { createHealthServer, loadHealthConfig, TickTracker } from "./health-server.js";
import { HttpWatcherApi } from "./http-client.js";
import { logger } from "./logger.js";
import { createConfiguredRunners } from "./runners/index.js";
import { installShutdownSignals } from "./shutdown-signals.js";
import { WorkerLoop } from "./worker-loop.js";

// Composition root for the watcher: build the API client and the runners the
// environment can support, advertise exactly those capabilities, and run the
// poll/execute loop until a shutdown signal. All job logic lives in the runners
// and the loop; this file only wires them together.

// Capture crashes outside handled paths (uncaught throws, unhandled rejections)
// with structured context and a clean non-zero exit for the restart policy,
// rather than a bare stderr trace. Registered before any work — including config
// loading below, which throws on a misconfiguration.
installCrashHandlers(logger);

// Validate all core wiring (API URL, poll interval, auth credentials) up front
// so a misconfigured watcher fails fast with an aggregated error instead of
// silently falling back to localhost defaults or 401ing every claim.
const config = loadWatcherConfig(process.env);

// Borrow the GitHub CLI's login when GITHUB_TOKEN is unset, before the runners and
// the `github` capability gate read it below.
const githubTokenSource = await hydrateGithubTokenFromGhCli();

// Start telemetry before the first API call so undici auto-instrumentation can
// patch fetch. A no-op (and never throws) when telemetry is disabled.
const telemetry: TelemetryHandle = await initTelemetry(config.telemetry, logger);

const apiBaseUrl = config.apiBaseUrl;
// Append a per-process uuid to the operator-set label so every running watcher —
// including multiple replicas that share one WATCHER_NAME — is a distinct entry
// in the connected-workers registry. A restart yields a new id (and the old one
// ages out of the registry), which is correct: a restarted process is a new one.
const watcherName = `${config.watcherName}-${randomUUID()}`;
const pollIntervalMs = config.pollIntervalMs;

// Authenticate to the API with the watcher's OWN machine-to-machine credential.
// Prefer client-credentials (WATCHER_API_CLIENT_ID/SECRET) so the token is
// fetched and refreshed at runtime — a static API_TOKEN expires (~24h on Auth0)
// and silently 401s every claim afterwards. The provider, downstream audience
// (Entra: API ID URI) and token endpoint come from the same auth settings the API
// validates against. When
// none of these are set (local dev with AUTH_REQUIRED=false) the provider yields
// undefined and no Authorization header is sent.
const tokenProvider = createApiTokenProvider({
  staticToken: config.auth.staticToken,
  clientId: config.auth.clientId,
  clientSecret: config.auth.clientSecret,
  provider: config.auth.provider,
  tokenUrl: config.auth.tokenUrl,
  audience: config.auth.audience,
  apiIdUri: config.auth.apiIdUri
});

const api = new HttpWatcherApi({
  apiBaseUrl,
  workerName: watcherName,
  token: tokenProvider,
  maintenanceTimeoutMs: config.maintenanceTimeoutMs,
  logger
});

const capabilityRuntime = DEFAULT_CAPABILITY_RUNTIME;
const runners = createConfiguredRunners(process.env, api, capabilityRuntime);
// Advertise capabilities from the single source of truth (the readiness gates),
// honouring the catalog contract that `maintenance` is always available. Every
// advertised capability has a runner here EXCEPT `maintenance`: its runner lands
// in Task 8, and no maintenance jobs are enqueued before then, so the broker has
// nothing to hand us in the meantime. If one ever arrived early the worker loop
// fails it safely (see WorkerLoop.execute's "no runner supports" branch).
const capabilities = deriveCapabilities(process.env, capabilityRuntime);

logger.info({ watcherName, apiBaseUrl, pollIntervalMs, githubTokenSource }, "watcher starting");
logCapabilityReadiness(process.env, capabilityRuntime);
logger.info({ capabilities }, "advertised capabilities");

if (capabilities.length === 0) {
  logger.warn(
    "No runner capabilities are configured; the watcher will idle. Configure a provider or GitHub credentials."
  );
}

// Fails fast on a malformed WATCHER_HEALTH_* override rather than silently
// falling back, so a typo surfaces at startup instead of as a confusing
// always-unhealthy (or wrong-port) container.
const healthConfig = loadHealthConfig(process.env);
const tickTracker = new TickTracker();
const healthServer = createHealthServer({
  config: healthConfig,
  tracker: tickTracker,
  isReady: () => capabilities.length > 0
});

const loop = new WorkerLoop(api, runners, capabilities, watcherName, logger, {
  pollIntervalMs,
  onTick: () => tickTracker.tick()
});

// The first SIGTERM/SIGINT only stops the poll loop, which aborts the in-flight
// runner and releases its job back to the queue (J53); the health server is
// closed once, after loop.run() resolves below, so there is a single shutdown
// path regardless of which signal (or neither) triggered it. A second signal, or
// the whole stop overrunning WATCHER_SHUTDOWN_TIMEOUT_MS, exits at once (J54).
installShutdownSignals({
  signals: process,
  timeoutMs: config.shutdownTimeoutMs,
  onShutdown: (signal) => {
    logger.info({ signal }, "received signal; releasing any in-flight job and shutting down");
    void loop.stop();
  },
  onForcedExit: (reason, signal) => {
    logger.error({ signal, reason, timeoutMs: config.shutdownTimeoutMs }, "forcing watcher exit");
    process.exit(1);
  }
});

await healthServer.start();
logger.info({ host: healthConfig.host, port: healthConfig.port }, "health server listening");

await loop.run();
await healthServer.stop();
// Flush and stop telemetry last so any span/metric from the final iteration is exported.
await telemetry.shutdown();
logger.info({ watcherName }, `Markdown Magpie watcher '${watcherName}' stopped`);
// Exit explicitly: a runner abandoned after ignoring its shutdown abort (J53)
// may still hold the event loop open (a child process, a socket), and the job it
// was running has already been released.
process.exit(0);

// Logs, per capability, whether each required env var is set or MISSING — never
// the secret values themselves — so a misconfiguration is visible at startup.
function logCapabilityReadiness(env: NodeJS.ProcessEnv, runtime: CapabilityRuntime): void {
  logger.info(
    { gitAvailable: runtime.gitAvailable() },
    `Git executable: ${runtime.gitAvailable() ? "available" : "MISSING"}`
  );
  for (const gate of CAPABILITY_GATES) {
    if (gate.requiredEnv.length === 0) {
      logger.info({ capability: gate.capability }, `Capability ${pad(gate.capability)} — always available`);
      continue;
    }
    const states = gate.requiredEnv.map((name) => `${name}: ${env[name]?.trim() ? "set" : "MISSING"}`);
    logger.info(
      { capability: gate.capability, ready: gate.ready(env, runtime) },
      `Capability ${pad(gate.capability)} — ${gate.ready(env, runtime) ? "ready" : "NOT ready"} (${states.join(", ")})`
    );
  }
}

function pad(capability: JobCapability): string {
  return capability.padEnd(18);
}
