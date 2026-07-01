import { serve } from "@hono/node-server";
import { createAppContext } from "./context.js";
import { loadConfig } from "./platform/config.js";
import { buildApp } from "./app.js";
import * as configService from "./features/config/service.js";
import { reconcileSchedules } from "./jobs/schedule-reconciler.js";
import { logger } from "./logger.js";

async function start(): Promise<void> {
  // Validate the environment first: a bad/missing required var aborts startup
  // here (caught below) before the broker connects or the server listens.
  const config = loadConfig();
  const port = config.port;
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
    process.exitCode = 1;
    return;
  }
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
    Promise.race([
      ctx.background.whenIdle(),
      new Promise((resolve) => setTimeout(resolve, config.apiShutdownDrainMs))
    ])
      .then(() => ctx.jobs.stop())
      // Close the shared store pool after the broker so no store query is mid-flight
      // when its connections are torn down. Best-effort: shutdown exits regardless.
      .then(() => ctx.pool?.end())
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
