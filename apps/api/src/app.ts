import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppContext } from "./context.js";
import { onError } from "./http/errors.js";
import { configRoutes } from "./features/config/routes.js";
import { askRoutes } from "./features/ask/routes.js";
import { knowledgeRoutes } from "./features/knowledge/routes.js";
import { questionRoutes } from "./features/questions/routes.js";
import { gapRoutes } from "./features/gaps/routes.js";
import { proposalRoutes } from "./features/proposals/routes.js";
import { crunchRoutes } from "./features/crunch/routes.js";
import { scheduledTaskRoutes } from "./features/scheduled-tasks/routes.js";
import { jobRoutes } from "./features/jobs/routes.js";
import { promptRoutes } from "./features/prompts/routes.js";

export function buildApp(ctx: AppContext): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type"]
    })
  );

  app.onError(onError);
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  const api = new Hono();

  api.get("/health", (c) => c.json({ ok: true, service: "markdown-magpie-api" }));

  api.route("/", configRoutes(ctx));
  api.route("/", askRoutes(ctx));
  api.route("/", knowledgeRoutes(ctx));
  api.route("/questions", questionRoutes(ctx));
  api.route("/gaps", gapRoutes(ctx));
  api.route("/proposals", proposalRoutes(ctx));
  api.route("/crunch", crunchRoutes(ctx));
  api.route("/scheduled-tasks", scheduledTaskRoutes(ctx));
  api.route("/ai-jobs", jobRoutes(ctx));
  api.route("/", promptRoutes(ctx));

  app.route("/api", api);

  return app;
}
