import { serve } from "@hono/node-server";
import { createAppContext } from "./context.js";
import { buildApp } from "./app.js";
import * as configService from "./features/config/service.js";
import { reconcileSchedules } from "./jobs/schedule-reconciler.js";
import { logger } from "./logger.js";

const port = Number.parseInt(process.env.PORT ?? "4000", 10);

async function start(): Promise<void> {
  const ctx = await createAppContext();
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
    const drainTimeoutMs = Number.parseInt(process.env.API_SHUTDOWN_DRAIN_MS ?? "10000", 10);
    const timeout = Number.isFinite(drainTimeoutMs) && drainTimeoutMs > 0 ? drainTimeoutMs : 10_000;
    Promise.race([
      ctx.background.whenIdle(),
      new Promise((resolve) => setTimeout(resolve, timeout))
    ]).then(() => ctx.jobs.stop()).finally(() => {
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
