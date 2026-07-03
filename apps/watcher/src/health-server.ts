import { createServer, type Server } from "node:http";

// A minimal liveness/readiness HTTP server for the watcher. Deliberately built
// on node:http rather than a framework — the watcher is a background worker,
// not a web app, and this endpoint exists purely so an orchestrator (Docker,
// Kubernetes, ...) can detect a wedged process.
//
// Liveness vs. readiness:
//   /health — is the process up AND is the poll/execute loop actually ticking?
//             A loop can be "up" (the process didn't crash) yet wedged forever
//             — e.g. the deliberate choice in worker-loop.ts to swallow claim
//             errors rather than crash means a misconfigured credential looks
//             alive with no other signal. /health closes that gap: it reports
//             unhealthy once the loop hasn't ticked within the staleness
//             threshold, regardless of why.
//   /ready  — has the watcher derived at least one runnable capability? A
//             watcher with zero capabilities will claim nothing forever; that
//             is a valid (if useless) "alive" state but not a useful "ready"
//             one, so it is split into its own check rather than folded into
//             liveness.

export interface HealthServerConfig {
  port: number;
  host: string;
  // How long (ms) the loop may go without ticking before /health reports 503.
  staleAfterMs: number;
}

const DEFAULT_PORT = 4002;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_STALE_AFTER_MS = 120_000;

// "0.0.0.0" / "::" (and an unset host) all mean "bind every interface". node:http
// binds every interface natively when no host is passed — crucially, without the
// dns.lookup() that any host string forces. That lookup hangs forever in sandboxes
// whose loopback getaddrinfo stalls (the same failure mode that wedged the mcp test
// suite), so recognising the all-interfaces hosts lets us skip it by construction.
function isAllInterfaces(host: string): boolean {
  return host === "" || host === "0.0.0.0" || host === "::";
}

// Reads and validates the health-server configuration from the environment.
// Fails fast (throws) on a malformed override rather than silently falling
// back, so a typo'd env var surfaces at startup instead of as a confusing
// always-unhealthy (or always-healthy) container.
export function loadHealthConfig(env: NodeJS.ProcessEnv): HealthServerConfig {
  return {
    port: parsePort(env.WATCHER_HEALTH_PORT, "WATCHER_HEALTH_PORT", DEFAULT_PORT),
    host: env.WATCHER_HEALTH_HOST?.trim() || DEFAULT_HOST,
    staleAfterMs: parsePositiveInt(env.WATCHER_HEALTH_STALE_AFTER_MS, "WATCHER_HEALTH_STALE_AFTER_MS", DEFAULT_STALE_AFTER_MS)
  };
}

function parsePort(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got: ${value}`);
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

// Tracks the last time the worker loop completed an iteration ("ticked"),
// independent of whether that iteration claimed a job. The loop calls tick()
// on every pass (claimed or idle-poll), so a healthy idle watcher still ticks
// every pollIntervalMs; only a loop stuck inside a single claim/execute call
// (or one that crashed out of run() entirely) goes stale.
export class TickTracker {
  private lastTickAt = Date.now();

  tick(): void {
    this.lastTickAt = Date.now();
  }

  msSinceLastTick(now: number = Date.now()): number {
    return now - this.lastTickAt;
  }
}

export interface HealthServerOptions {
  config: HealthServerConfig;
  tracker: TickTracker;
  // Reports whether the watcher currently advertises at least one runnable
  // capability. Cheap by construction (deriveCapabilities is pure env lookups),
  // so /ready can call it directly rather than caching.
  isReady: () => boolean;
}

export interface HealthServer {
  readonly server: Server;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// Builds (but does not start) the health/liveness HTTP server.
export function createHealthServer(options: HealthServerOptions): HealthServer {
  const { config, tracker, isReady } = options;

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];

    if (path === "/health") {
      const staleness = tracker.msSinceLastTick();
      const alive = staleness <= config.staleAfterMs;
      res.writeHead(alive ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: alive ? "ok" : "stale", msSinceLastTick: staleness }));
      return;
    }

    if (path === "/ready") {
      const ready = isReady();
      res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: ready ? "ok" : "not_ready" }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return {
    server,
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        const onListening = () => {
          server.removeListener("error", reject);
          resolve();
        };
        // Passing a host string routes the bind through node:net's dns.lookup(),
        // even for a literal IP like "127.0.0.1" — which stalls forever in a
        // sandbox whose loopback getaddrinfo hangs. An all-interfaces bind needs
        // no resolution, so omit the host in that case and skip the lookup.
        if (isAllInterfaces(config.host)) {
          server.listen(config.port, onListening);
        } else {
          server.listen(config.port, config.host, onListening);
        }
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}
