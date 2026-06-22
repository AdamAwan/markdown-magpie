import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { AppContext } from "./context.js";
import { onError } from "./http/errors.js";
import { configRoutes, adminRoutes } from "./features/config/routes.js";
import { askRoutes } from "./features/ask/routes.js";
import { retrieveRoutes } from "./features/retrieve/routes.js";
import { knowledgeRoutes } from "./features/knowledge/routes.js";
import { questionRoutes } from "./features/questions/routes.js";
import { gapRoutes } from "./features/gaps/routes.js";
import { proposalRoutes } from "./features/proposals/routes.js";
import { crunchRoutes } from "./features/crunch/routes.js";
import { sourceSyncRoutes } from "./features/source-sync/routes.js";
import { scheduledTaskRoutes } from "./features/scheduled-tasks/routes.js";
import { jobRoutes } from "./features/jobs/routes.js";
import { workerRoutes } from "./features/workers/routes.js";
import { promptRoutes } from "./features/prompts/routes.js";
import { snapshotRoutes } from "./features/snapshots/routes.js";
import { reconciliationRoutes } from "./features/reconciliations/routes.js";
import { requireAuth, type ApiAuthOptions } from "./auth/middleware.js";

export function buildApp(ctx: AppContext, options: ApiAuthOptions = {}): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type", "authorization"]
    })
  );

  // Cap request bodies so a single oversized upload can't exhaust memory.
  app.use(
    "*",
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: (c) => c.json({ error: "payload_too_large" }, 413)
    })
  );

  app.onError(onError);
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  const api = new Hono();

  api.get("/health", (c) => c.json({ ok: true, service: "markdown-magpie-api" }));
  api.use("*", requireAuth(options));

  // Every feature module owns one prefix and declares relative paths internally.
  api.route("/config", configRoutes(ctx));
  api.route("/admin", adminRoutes(ctx));
  api.route("/ask", askRoutes(ctx));
  api.route("/retrieve", retrieveRoutes(ctx));
  api.route("/knowledge", knowledgeRoutes(ctx));
  api.route("/questions", questionRoutes(ctx));
  api.route("/gaps", gapRoutes(ctx));
  api.route("/proposals", proposalRoutes(ctx));
  api.route("/crunch", crunchRoutes(ctx));
  api.route("/source-sync", sourceSyncRoutes(ctx));
  api.route("/scheduled-tasks", scheduledTaskRoutes(ctx));
  api.route("/jobs", jobRoutes(ctx));
  api.route("/workers", workerRoutes(ctx));
  api.route("/prompts", promptRoutes(ctx));
  api.route("/snapshots", snapshotRoutes(ctx));
  api.route("/reconciliations", reconciliationRoutes(ctx));

  app.route("/api", api);

  return app;
}
