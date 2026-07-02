import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { adminRoutes } from "./routes.js";

// The destructive /admin/reset route requires the `admin` capability on top of its
// manage:admin scope, so an ordinary admin can't wipe all data by scope alone.

function principal(roles: string[] | undefined): Principal {
  return { subject: "auth0|tester", scopes: ["manage:admin"], roles, payload: {} };
}

function appFor(ctx: AppContext, who: Principal): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authRequired", true);
    c.set("principal", who);
    await next();
  });
  app.route("/admin", adminRoutes(ctx));
  app.onError(onError);
  return app;
}

function withGrants(grants: AppContext["knowledgeConfig"]["roleGrants"]): AppContext {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.roleGrants = grants;
  return ctx;
}

async function reset(app: Hono): Promise<Response> {
  return app.request("/admin/reset", { method: "POST" });
}

describe("admin reset flow scoping", () => {
  it("allows a super-admin (admin on *)", async () => {
    const ctx = withGrants({ "kb-super": { "*": ["admin"] } });
    const res = await reset(appFor(ctx, principal(["kb-super"])));
    assert.equal(res.status, 200);
  });

  it("forbids a role-aware admin without the admin capability", async () => {
    const ctx = withGrants({ "kb-hr-curators": { hr: ["read", "manage"] } });
    const res = await reset(appFor(ctx, principal(["kb-hr-curators"])));
    assert.equal(res.status, 403);
  });

  it("lets a service/M2M principal (no roles claim) through", async () => {
    const ctx = withGrants({ "kb-super": { "*": ["admin"] } });
    const res = await reset(appFor(ctx, principal(undefined)));
    assert.equal(res.status, 200);
  });

  it("is scope-only when no grants are configured", async () => {
    const ctx = withGrants({});
    const res = await reset(appFor(ctx, principal(["kb-hr-curators"])));
    assert.equal(res.status, 200);
  });
});
