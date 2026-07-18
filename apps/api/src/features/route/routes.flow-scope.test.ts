import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { logger } from "../../logger.js";
import { routeRoutes } from "./routes.js";

// /api/route lets the caller route a question freely across the flows it supplies,
// so — exactly like /api/ask with flow "auto"/absent — it is the flow-less case:
// only a wildcard `ask` asker (or a genuine service principal) may use it. Capability
// evaluation itself is unit-tested in auth/capabilities.test.ts.

function principal(roles: string[] | undefined): Principal {
  return {
    subject: "auth0|tester",
    scopes: ["ask:knowledge"],
    roles,
    payload: {}
  };
}

function m2m(): Principal {
  return {
    subject: "svc@clients",
    scopes: ["ask:knowledge"],
    roles: undefined,
    payload: { gty: "client-credentials" }
  };
}

function appFor(ctx: AppContext, who: Principal): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authRequired", true);
    c.set("principal", who);
    c.set("logger", logger);
    await next();
  });
  app.route("/route", routeRoutes(ctx));
  app.onError(onError);
  return app;
}

const FLOWS = [
  { id: "hr", name: "HR" },
  { id: "eng", name: "Eng" }
];

async function post(app: Hono): Promise<Response> {
  return app.request("/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "how do I deploy the service", flows: FLOWS })
  });
}

function twoFlowCtx(): AppContext {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "hr", name: "HR", sourceIds: [], destinationId: "hr-kb" },
    { id: "eng", name: "Eng", sourceIds: [], destinationId: "eng-kb" }
  ];
  ctx.knowledgeConfig.roleGrants = { "kb-hr-askers": { hr: ["ask"] } };
  return ctx;
}

describe("route routes flow scoping", () => {
  it("forbids free routing for a single-flow asker (no wildcard capability)", async () => {
    const res = await post(appFor(twoFlowCtx(), principal(["kb-hr-askers"])));
    assert.equal(res.status, 403);
  });

  it("allows free routing for a wildcard asker", async () => {
    const ctx = twoFlowCtx();
    ctx.knowledgeConfig.roleGrants = { "kb-all-askers": { "*": ["ask"] } };
    const res = await post(appFor(ctx, principal(["kb-all-askers"])));
    assert.equal(res.status, 200);
  });

  it("lets a genuine service/M2M principal route freely (watcher callback)", async () => {
    const res = await post(appFor(twoFlowCtx(), m2m()));
    assert.equal(res.status, 200);
  });

  it("forbids a human token missing its roles claim (fails closed, not treated as M2M)", async () => {
    const res = await post(appFor(twoFlowCtx(), principal(undefined)));
    assert.equal(res.status, 403);
  });

  it("allows free routing when no grants are configured (feature inactive)", async () => {
    const ctx = twoFlowCtx();
    ctx.knowledgeConfig.roleGrants = {};
    const res = await post(appFor(ctx, principal(["anyone"])));
    assert.equal(res.status, 200);
  });

  // Body validation runs before capability evaluation, so an oversized candidate
  // set (or per-flow string) is rejected with 400 rather than bounded only by the
  // global 4 MB body cap (#293).
  it("rejects an oversized flows array with 400", async () => {
    const app = appFor(twoFlowCtx(), principal(["anyone"]));
    const flows = Array.from({ length: 201 }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));
    const res = await app.request("/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "q", flows })
    });
    assert.equal(res.status, 400);
  });
});
