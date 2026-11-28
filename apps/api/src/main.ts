import { getRequestListener } from "@hono/node-server";
import { hydrateGithubTokenFromGhCli } from "@magpie/git";
import { installCrashHandlers } from "@magpie/logger";
import { initTelemetry, type TelemetryHandle } from "@magpie/telemetry";
import { createAppContext } from "./context.js";
import { loadConfig } from "./platform/config.js";
import { buildApp } from "./app.js";
import * as configService from "./features/config/service.js";
import { reconcileSchedules } from "./jobs/schedule-reconciler.js";
import { startFailureSweep } from "./features/jobs/failure-sweep.js";
import { preflightDataPaths } from "./platform/preflight.js";
import { startQueueMetrics } from "./platform/queue-stats.js";
import { checkoutRoot, snapshotRoot } from "./platform/repositories.js";
import { logger } from "./logger.js";
import { createDrainableServer, installGracefulShutdown } from "./shutdown.js";

// Capture crashes outside handled paths (uncaught throws, unhandled rejections)
// with structured context and a clean non-zero exit for the restart policy,
// rather than a bare stderr trace. Registered before any work starts.
installCrashHandlers(logger);

async function start(): Promise<void> {
  // Borrow the GitHub CLI's login when GITHUB_TOKEN is unset, before config (and
  // every git/PR call) reads it.
  const githubTokenSource = await hydrateGithubTokenFromGhCli();
  logger.info({ githubTokenSource }, "GitHub token source");
  // Validate the environment first: a bad/missing required var aborts startup
  // here (caught below) before the broker connects or the server listens.
  const config = loadConfig();
  const port = config.port;
  // Start telemetry before any HTTP/pg client is created so the auto-instrumentation
  // can patch them. A no-op (and never throws) when telemetry is disabled.
  const telemetry: TelemetryHandle = await initTelemetry(config.telemetry, logger);
  const ctx = await createAppContext(config);
  try {
    await ctx.jobs.start();
    await ctx.bootstrap();
    // Reconcile saved product schedules into pg-boss now the broker is up. The
    // queue, not an in-process timer, fires scheduled work from here on.
    await reconcileSchedules(ctx);
    // Queue-health gauges (O16–O22); read only at telemetry collection time.
    startQueueMetrics(ctx);
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : "Unknown error" }, "API startup failed");
    await ctx.jobs.stop().catch(() => undefined);
    await telemetry.shutdown().catch(() => undefined);
    process.exitCode = 1;
    return;
  }
  // Settle the side effects of jobs pg-boss fails by itself (expiry, lost
  // heartbeat) — features/jobs/failure-sweep.ts. Stopped before the broker.
  const failureSweep = startFailureSweep(ctx);
  // Non-fatal: warn loudly if a configured data directory is not writable, so an
  // unmounted/misowned path surfaces as one boot warning rather than a silent
  // per-run failure (issue #130). Resolved to absolute paths the same way the
  // stores do, so the message names exactly the directory the app will use.
  await preflightDataPaths(
    [
      { label: "Snapshot directory", envVar: "MAGPIE_SNAPSHOT_ROOT", dir: snapshotRoot(config) },
      { label: "Checkout directory", envVar: "MAGPIE_CHECKOUT_ROOT", dir: checkoutRoot(config) }
    ],
    logger
  );
  const app = buildApp(ctx);
  // A drainable node:http server (rather than @hono/node-server's serve(), whose
  // HTTP/1-or-2 union type hides http.Server's connection controls) so SIGTERM
  // can finish in-flight requests before teardown — see shutdown.ts.
  const server = createDrainableServer(getRequestListener(app.fetch));
  server.server.listen(port, () => {
    logger.info({ port }, "Markdown Magpie API listening");
    configService.logStartupConfig(ctx);
  });

  // On SIGTERM/SIGINT: stop accepting connections, let in-flight HTTP handlers
  // and background work (merge cascades, manual task runs) finish within the
  // drain window, then stop the broker, then end the store pool — after the
  // broker, so no store query is mid-flight when its connections go — and flush
  // telemetry last so any span/metric from the drain is exported. A second
  // signal exits at once. See shutdown.ts and docs/api.md API37/API38.
  installGracefulShutdown({
    server,
    drainMs: config.apiShutdownDrainMs,
    background: ctx.background,
    steps: [
      { name: "failure sweep", run: () => failureSweep.stop() },
      { name: "job broker", run: () => ctx.jobs.stop() },
      { name: "store pool", run: async () => ctx.pool?.end() },
      { name: "telemetry", run: () => telemetry.shutdown() }
    ],
    logger,
    exit: (code) => process.exit(code),
    signals: process
  });
}

void start().catch((error) => {
  logger.error({ err: error instanceof Error ? error.message : "Unknown error" }, "API startup failed");
  process.exitCode = 1;
});
