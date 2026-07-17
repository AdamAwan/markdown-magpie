import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { logger } from "../../logger.js";
import { retrieveRoutes } from "./routes.js";

// Verifies /api/retrieve applies the same per-flow `ask` capability gate as
// /api/ask, so a role-aware user cannot read section content for a flow they hold
// no capability on (or search all flows unscoped). Capability evaluation itself is
// unit-tested in auth/capabilities.test.ts.

function principal(roles: string[] | undefined): Principal {
  return {
    subject: "auth0|tester",
    scopes: ["ask:knowledge"],
    roles,
    payload: {}
  };
}

// A genuine machine-to-machine token (the watcher): no roles claim, but carrying
// the POSITIVE Auth0 client-credentials marker that identifies a service identity.
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
  app.route("/retrieve", retrieveRoutes(ctx));
  app.onError(onError);
  return app;
}

async function post(app: Hono, body: Record<string, unknown>): Promise<Response> {
  return app.request("/retrieve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
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

describe("retrieve routes flow scoping", () => {
  it("allows retrieve on a flow the principal can ask", async () => {
    const res = await post(appFor(twoFlowCtx(), principal(["kb-hr-askers"])), {
      question: "how do I request leave",
      flowId: "hr"
    });
    assert.equal(res.status, 200);
  });

  it("forbids retrieve on a flow the principal cannot ask (cross-flow content disclosure)", async () => {
    const res = await post(appFor(twoFlowCtx(), principal(["kb-hr-askers"])), {
      question: "how do I deploy the service",
      flowId: "eng"
    });
    assert.equal(res.status, 403);
  });

  it("forbids an unscoped (all-flows) retrieve for a single-flow asker", async () => {
    const res = await post(appFor(twoFlowCtx(), principal(["kb-hr-askers"])), {
      question: "how do I deploy the service"
    });
    assert.equal(res.status, 403);
  });

  it("allows an unscoped retrieve for a wildcard asker", async () => {
    const ctx = twoFlowCtx();
    ctx.knowledgeConfig.roleGrants = { "kb-all-askers": { "*": ["ask"] } };
    const res = await post(appFor(ctx, principal(["kb-all-askers"])), {
      question: "how do I deploy the service"
    });
    assert.equal(res.status, 200);
  });

  it("lets a genuine service/M2M principal retrieve any flow (watcher callback)", async () => {
    const res = await post(appFor(twoFlowCtx(), m2m()), {
      question: "how do I deploy the service",
      flowId: "eng"
    });
    assert.equal(res.status, 200);
  });

  it("forbids a human token missing its roles claim (fails closed, not treated as M2M)", async () => {
    const res = await post(appFor(twoFlowCtx(), principal(undefined)), {
      question: "how do I deploy the service",
      flowId: "eng"
    });
    assert.equal(res.status, 403);
  });
});
