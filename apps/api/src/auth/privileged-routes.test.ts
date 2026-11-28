import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { AuthProvider, Principal } from "@magpie/auth";
import type { AppContext } from "../context.js";
import { onError } from "../http/errors.js";
import { logger } from "../logger.js";
import { makeTestContext } from "../test-support/context.js";
import { adminRoutes, configRoutes } from "../features/config/routes.js";
import { jobRoutes } from "../features/jobs/routes.js";
import { fixPatrolRoutes } from "../features/patrol/routes.js";
import { questionRoutes } from "../features/questions/routes.js";
import { scheduledTaskRoutes } from "../features/scheduled-tasks/routes.js";
import { seedRoutes } from "../features/seed/routes.js";
import { sourceSyncRoutes } from "../features/source-sync/routes.js";

// docs/authorization.md AZ27: on a provider whose user-token scopes are not
// per-user (Entra), privileged routes authorize HUMAN principals from app roles
// (`admin` / `ops` on "*" via KNOWLEDGE_ROLE_GRANTS), not from the delegated
// scopes every user receives. Service principals and Auth0 keep scope-only gates.

const ALL_SCOPES = ["read:knowledge", "manage:knowledge", "manage:jobs", "manage:admin"];

function human(roles: string[] | undefined): Principal {
  return { subject: "user-oid", scopes: ALL_SCOPES, roles, isService: false, payload: {} };
}

function service(): Principal {
  return { subject: "watcher-app", scopes: ALL_SCOPES, roles: undefined, isService: true, payload: { idtyp: "app" } };
}

function contextFor(provider: AuthProvider): AppContext {
  const ctx = makeTestContext();
  ctx.settings = { ...ctx.settings, auth: { ...ctx.settings.auth, provider, required: true } };
  ctx.knowledgeConfig.roleGrants = {
    "magpie-admins": { "*": ["admin", "ops"] },
    "magpie-ops": { "*": ["ops"] },
    "kb-hr-curators": { hr: ["read", "manage"] }
  };
  return ctx;
}

function appFor(ctx: AppContext, who: Principal): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("logger", logger);
    c.set("authRequired", true);
    c.set("principal", who);
    await next();
  });
  app.route("/config", configRoutes(ctx));
  app.route("/admin", adminRoutes(ctx));
  app.route("/jobs", jobRoutes(ctx));
  app.route("/questions", questionRoutes(ctx));
  app.route("/scheduled-tasks", scheduledTaskRoutes(ctx));
  app.route("/fix-patrol", fixPatrolRoutes(ctx));
  app.route("/source-sync", sourceSyncRoutes(ctx));
  app.route("/flows", seedRoutes(ctx));
  app.onError(onError);
  return app;
}

interface PrivilegedRoute {
  capability: "admin" | "ops";
  method: string;
  path: string;
  body?: unknown;
}

// Each request is shaped so an AUTHORIZED caller gets a deterministic non-403
// (usually a 400/404 for the dummy id or body) without side effects.
const ROUTES: PrivilegedRoute[] = [
  { capability: "admin", method: "POST", path: "/config", body: {} },
  { capability: "admin", method: "DELETE", path: "/questions/missing" },
  { capability: "ops", method: "POST", path: "/jobs", body: { type: "not-a-job" } },
  { capability: "ops", method: "POST", path: "/jobs/missing/cancel" },
  { capability: "ops", method: "POST", path: "/jobs/missing/retry" },
  { capability: "ops", method: "POST", path: "/jobs/missing/accept-failure" },
  { capability: "ops", method: "POST", path: "/scheduled-tasks/missing/settings", body: { cron: "nope" } },
  { capability: "ops", method: "POST", path: "/scheduled-tasks/missing/run" },
  { capability: "ops", method: "POST", path: "/flows/missing/seed-bootstrap/run" },
  { capability: "ops", method: "POST", path: "/fix-patrol/run", body: { flowId: "missing" } },
  { capability: "ops", method: "POST", path: "/fix-patrol/improve/run", body: { flowId: "missing" } },
  { capability: "ops", method: "POST", path: "/source-sync/run", body: { flowId: "missing" } }
];

async function call(app: Hono, route: PrivilegedRoute): Promise<number> {
  const res = await app.request(route.path, {
    method: route.method,
    headers: { "content-type": "application/json" },
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) })
  });
  return res.status;
}

describe("privileged routes on Entra (AZ27)", () => {
  for (const route of ROUTES) {
    const label = `${route.method} ${route.path}`;

    it(`${label}: denies a human holding every delegated scope but no ${route.capability} role`, async () => {
      const ctx = contextFor("entra");
      assert.equal(await call(appFor(ctx, human(["kb-hr-curators"])), route), 403);
      assert.equal(await call(appFor(ctx, human([])), route), 403);
      assert.equal(await call(appFor(ctx, human(undefined)), route), 403);
    });

    it(`${label}: allows a human whose role grants ${route.capability} on *`, async () => {
      const ctx = contextFor("entra");
      const role = route.capability === "admin" ? "magpie-admins" : "magpie-ops";
      assert.notEqual(await call(appFor(ctx, human([role])), route), 403);
    });

    it(`${label}: allows a genuine service principal`, async () => {
      assert.notEqual(await call(appFor(contextFor("entra"), service()), route), 403);
    });

    it(`${label}: stays scope-only on Auth0 (per-user scopes)`, async () => {
      assert.notEqual(await call(appFor(contextFor("auth0"), human([])), route), 403);
    });
  }

  it("an ops role does not confer admin", async () => {
    const ctx = contextFor("entra");
    assert.equal(await call(appFor(ctx, human(["magpie-ops"])), ROUTES[0]!), 403);
  });

  it("POST /admin/reset requires the admin role on Entra", async () => {
    const ctx = contextFor("entra");
    const reset = (who: Principal) => appFor(ctx, who).request("/admin/reset", { method: "POST" });
    assert.equal((await reset(human(["magpie-ops"]))).status, 403);
    assert.equal((await reset(human(["magpie-admins"]))).status, 200);
  });
});
