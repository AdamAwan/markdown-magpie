import { serve } from "@hono/node-server";
import { createAppContext } from "./context.js";
import { buildApp } from "./app.js";
import * as configService from "./features/config/service.js";
import { CrunchScheduler } from "./scheduling/crunch-scheduler.js";
import { TaskScheduler } from "./scheduling/task-scheduler.js";

const port = Number.parseInt(process.env.PORT ?? "4000", 10);

async function start(): Promise<void> {
  const ctx = await createAppContext();
  try {
    await ctx.bootstrap();
  } catch (error) {
    console.error(
      `Failed to sync configured git repositories: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exitCode = 1;
    return;
  }
  const app = buildApp(ctx);
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Markdown Magpie API listening on http://localhost:${port}/api`);
    configService.logStartupConfig(ctx);
    new CrunchScheduler(ctx).start();
    new TaskScheduler(ctx).start();
  });
}

void start();
