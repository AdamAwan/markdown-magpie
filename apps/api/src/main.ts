import { serve } from "@hono/node-server";
import { installCrashHandlers } from "@magpie/logger";
import { initTelemetry, type TelemetryHandle } from "@magpie/telemetry";
import { createAppContext } from "./context.js";
import { loadConfig } from "./platform/config.js";
import { buildApp } from "./app.js";
import * as configService from "./features/config/service.js";
import { reconcileSchedules } from "./jobs/schedule-reconciler.js";
import { preflightDataPaths } from "./platform/preflight.js";
import { checkoutRoot, snapshotRoot } from "./platform/repositories.js";
import { logger } from "./logger.js";

// Capture crashes outside handled paths (uncaught throws, unhandled rejections)
// with structured context and a clean non-zero exit for the restart policy,
// rather than a bare stderr trace. Registered before any work starts.
installCrashHandlers(logger);

async function start(): Promise<void> {
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
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : "Unknown error" }, "API startup failed");
    await ctx.jobs.stop().catch(() => undefined);
    await telemetry.shutdown().catch(() => undefined);
    process.exitCode = 1;
    return;
  }
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
  const server = serve({ fetch: app.fetch, port }, () => {
    logger.info({ port }, "Markdown Magpie API listening");
    configService.logStartupConfig(ctx);
  });

  // On a normal stop, stop accepting connections and give in-flight background
  // work (merge cascades, crunch planning, manual task runs) a bounded window to
  // finish so it isn't silently dropped mid-flight.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "received signal; draining background work before exit");
    server.close();
    Promise.race([ctx.background.whenIdle(), new Promise((resolve) => setTimeout(resolve, config.apiShutdownDrainMs))])
      .then(() => ctx.jobs.stop())
      // Close the shared store pool after the broker so no store query is mid-flight
      // when its connections are torn down. Best-effort: shutdown exits regardless.
      .then(() => ctx.pool?.end())
      // Flush and stop telemetry last so any span/metric from the drain is exported.
      .then(() => telemetry.shutdown())
      .catch((error) =>
        logger.warn(
          { err: error instanceof Error ? error.message : "Unknown error" },
          "error draining background work on shutdown"
        )
      )
      .finally(() => {
        if (ctx.background.pending > 0) {
          logger.warn({ pending: ctx.background.pending }, "exiting with background tasks still in flight");
        }
        process.exit(0);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

void start().catch((error) => {
  logger.error({ err: error instanceof Error ? error.message : "Unknown error" }, "API startup failed");
  process.exitCode = 1;
});
