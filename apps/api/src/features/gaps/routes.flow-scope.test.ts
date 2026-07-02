import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { gapRoutes } from "./routes.js";

// Verifies the gap routes apply flow-scoped authorization (clusters list filtering
// and the manage gate on reconcile). Capability evaluation is unit-tested in
// auth/capabilities.test.ts.

function principal(roles: string[] | undefined): Principal {
  return {
    subject: "auth0|tester",
    scopes: ["read:knowledge", "manage:knowledge", "manage:jobs"],
    roles,
    payload: {}
  };
}

function appFor(ctx: AppContext, who: Principal): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authRequired", true);
    c.set("principal", who);
    await next();
  });
  app.route("/gaps", gapRoutes(ctx));
  app.onError(onError);
  return app;
}

function twoFlowCtx(): AppContext {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "hr", name: "HR", sourceIds: [], destinationId: "hr-kb" },
    { id: "eng", name: "Eng", sourceIds: [], destinationId: "eng-kb" }
  ];
  ctx.knowledgeConfig.roleGrants = { "kb-hr-curators": { hr: ["read", "manage"] } };
  return ctx;
}

describe("gap routes flow scoping", () => {
  it("filters clusters to flows the principal can read", async () => {
    const ctx = twoFlowCtx();
    const hr = await ctx.stores.gapClusters.createCluster({ flowId: "hr", title: "HR gap", revision: 1 });
    await ctx.stores.gapClusters.createCluster({ flowId: "eng", title: "Eng gap", revision: 1 });

    const res = await appFor(ctx, principal(["kb-hr-curators"])).request("/gaps/clusters");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { clusters: Array<{ id: string }> };
    assert.deepEqual(
      body.clusters.map((cluster) => cluster.id),
      [hr.id]
    );
  });

  it("allows reconcile of a flow the principal can manage", async () => {
    const ctx = twoFlowCtx();
    const res = await appFor(ctx, principal(["kb-hr-curators"])).request("/gaps/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flowId: "hr" })
    });
    assert.equal(res.status, 200);
  });

  it("forbids reconcile of a flow the principal cannot manage", async () => {
    const ctx = twoFlowCtx();
    const res = await appFor(ctx, principal(["kb-hr-curators"])).request("/gaps/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flowId: "eng" })
    });
    assert.equal(res.status, 403);
  });

  it("lets a service/M2M principal (no roles claim) reconcile any flow", async () => {
    const ctx = twoFlowCtx();
    const res = await appFor(ctx, principal(undefined)).request("/gaps/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flowId: "eng" })
    });
    assert.equal(res.status, 200);
  });
});
