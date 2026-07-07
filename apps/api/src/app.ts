import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { AppContext } from "./context.js";
import { onError } from "./http/errors.js";
import { configRoutes, adminRoutes } from "./features/config/routes.js";
import { askRoutes } from "./features/ask/routes.js";
import { retrieveRoutes } from "./features/retrieve/routes.js";
import { routeRoutes } from "./features/route/routes.js";
import { knowledgeRoutes } from "./features/knowledge/routes.js";
import { questionRoutes } from "./features/questions/routes.js";
import { gapRoutes } from "./features/gaps/routes.js";
import { seedRoutes } from "./features/seed/routes.js";
import { proposalRoutes } from "./features/proposals/routes.js";
import { sourceSyncRoutes } from "./features/source-sync/routes.js";
import { fixPatrolRoutes } from "./features/patrol/routes.js";
import { maintenanceRunRoutes } from "./features/maintenance-runs/routes.js";
import { scheduledTaskRoutes } from "./features/scheduled-tasks/routes.js";
import { jobRoutes } from "./features/jobs/routes.js";
import { workerRoutes } from "./features/workers/routes.js";
import { promptRoutes } from "./features/prompts/routes.js";
import { snapshotRoutes } from "./features/snapshots/routes.js";
import { reconciliationRoutes } from "./features/reconciliations/routes.js";
import { insightsRoutes } from "./features/insights/routes.js";
import { requireAuth, type ApiAuthOptions } from "./auth/middleware.js";
import { getBuildInfo } from "./build-info.js";
import { requestLogging } from "./http/logging.js";
import { logger } from "./logger.js";

export function buildApp(ctx: AppContext, options?: ApiAuthOptions): Hono {
  // Default auth from the validated config (the single source of truth) rather
  // than re-reading process.env, so the app enforces exactly what loadConfig
  // validated and tests disable auth purely via the injected context.
  const authOptions: ApiAuthOptions = options ?? { auth: ctx.settings.auth };
  const app = new Hono();

  app.use("*", requestLogging(logger));

  // Standard security headers (nosniff, frame-deny, HSTS, referrer policy, …) on
  // every response as defense-in-depth. HSTS is only honoured by browsers over
  // HTTPS, so it is inert in plain-HTTP local dev; production is expected to
  // terminate TLS upstream. Runs before cors so the headers are also present on
  // the short-circuited OPTIONS preflight response.
  app.use("*", secureHeaders());

  app.use(
    "*",
    cors({
      // Defaults to "*" (any origin); set CORS_ALLOWED_ORIGINS to a comma-
      // separated allow-list to restrict which web origins may call the API.
      origin: ctx.settings.cors.allowedOrigins,
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
  // Public, like /health: lets the console show the live build (commit, message,
  // merge time) without requiring a token.
  api.get("/version", (c) => c.json(getBuildInfo()));
  // Deep readiness (vs. /health's shallow liveness): verifies the real
  // dependencies an orchestrator cares about before routing traffic — Postgres
  // is reachable (SELECT 1 via the shared pool) and the job broker has started.
  // Public/auth-exempt so probes need no token. 200 when ready, 503 otherwise.
  api.get("/ready", async (c) => {
    const brokerStarted = ctx.jobs.isStarted();
    let databaseOk = true;
    // No pool means every store is in-memory (e.g. tests) — there is no Postgres
    // dependency to verify, so it is trivially "ok".
    if (ctx.pool) {
      try {
        await ctx.pool.query("SELECT 1");
      } catch (error) {
        databaseOk = false;
        logger.warn(
          { err: error instanceof Error ? error.message : "Unknown error" },
          "readiness: database check failed"
        );
      }
    }
    const ready = databaseOk && brokerStarted;
    return c.json(
      { ready, checks: { database: databaseOk, broker: brokerStarted } },
      ready ? 200 : 503
    );
  });
  api.use("*", requireAuth(authOptions));

  // Every feature module owns one prefix and declares relative paths internally.
  api.route("/config", configRoutes(ctx));
  api.route("/admin", adminRoutes(ctx));
  api.route("/ask", askRoutes(ctx));
  api.route("/retrieve", retrieveRoutes(ctx));
  api.route("/route", routeRoutes(ctx));
  api.route("/knowledge", knowledgeRoutes(ctx));
  api.route("/questions", questionRoutes(ctx));
  api.route("/gaps", gapRoutes(ctx));
  api.route("/flows", seedRoutes(ctx));
  api.route("/proposals", proposalRoutes(ctx));
  api.route("/source-sync", sourceSyncRoutes(ctx));
  api.route("/fix-patrol", fixPatrolRoutes(ctx));
  api.route("/maintenance-runs", maintenanceRunRoutes(ctx));
  api.route("/scheduled-tasks", scheduledTaskRoutes(ctx));
  api.route("/jobs", jobRoutes(ctx));
  api.route("/workers", workerRoutes(ctx));
  api.route("/prompts", promptRoutes(ctx));
  api.route("/snapshots", snapshotRoutes(ctx));
  api.route("/reconciliations", reconciliationRoutes(ctx));
  api.route("/insights", insightsRoutes(ctx));

  app.route("/api", api);

  return app;
}
