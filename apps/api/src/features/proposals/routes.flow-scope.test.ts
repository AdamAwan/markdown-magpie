import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { proposalRoutes } from "./routes.js";

// Exercises the flow-scoped authorization wiring on the proposal routes. The
// capability evaluation itself is unit-tested in auth/capabilities.test.ts; here we
// verify the routes apply it (list filtering, cross-flow hiding, service bypass).

function principal(roles: string[] | undefined): Principal {
  return {
    subject: "auth0|tester",
    scopes: ["read:knowledge", "manage:knowledge"],
    roles,
    payload: {}
  };
}

function appFor(ctx: AppContext, who: Principal): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // Stand in for requireAuth having verified a token.
    c.set("authRequired", true);
    c.set("principal", who);
    await next();
  });
  app.route("/proposals", proposalRoutes(ctx));
  // Mirror buildApp so thrown HttpErrors map to their status codes.
  app.onError(onError);
  return app;
}

async function seedTwoFlows(): Promise<{ ctx: AppContext; hrId: string; engId: string }> {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.roleGrants = { "kb-hr-curators": { hr: ["read", "manage"] } };
  const hr = await ctx.stores.proposals.create({
    title: "HR draft",
    targetPath: "hr/leave.md",
    markdown: "# Leave",
    rationale: "r",
    evidence: [],
    flowId: "hr"
  });
  const eng = await ctx.stores.proposals.create({
    title: "Eng draft",
    targetPath: "eng/deploy.md",
    markdown: "# Deploy",
    rationale: "r",
    evidence: [],
    flowId: "eng"
  });
  return { ctx, hrId: hr.id, engId: eng.id };
}

describe("proposal routes flow scoping", () => {
  it("filters the list to flows the principal can read", async () => {
    const { ctx, hrId } = await seedTwoFlows();
    const res = await appFor(ctx, principal(["kb-hr-curators"])).request("/proposals");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { proposals: Array<{ id: string; flowId?: string }> };
    assert.deepEqual(
      body.proposals.map((p) => p.id),
      [hrId]
    );
  });

  it("reports a proposal in another flow as not-found (no cross-flow enumeration)", async () => {
    const { ctx, engId } = await seedTwoFlows();
    const res = await appFor(ctx, principal(["kb-hr-curators"])).request(`/proposals/${engId}`);
    assert.equal(res.status, 404);
  });

  it("serves a proposal in the principal's own flow", async () => {
    const { ctx, hrId } = await seedTwoFlows();
    const res = await appFor(ctx, principal(["kb-hr-curators"])).request(`/proposals/${hrId}`);
    assert.equal(res.status, 200);
  });

  it("lets a service/M2M principal (no roles claim) see every flow", async () => {
    const { ctx } = await seedTwoFlows();
    const res = await appFor(ctx, principal(undefined)).request("/proposals");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { proposals: unknown[] };
    assert.equal(body.proposals.length, 2);
  });

  it("is inactive when no grants are configured (role-aware principal sees all)", async () => {
    const { ctx } = await seedTwoFlows();
    ctx.knowledgeConfig.roleGrants = {};
    const res = await appFor(ctx, principal(["kb-hr-curators"])).request("/proposals");
    const body = (await res.json()) as { proposals: unknown[] };
    assert.equal(body.proposals.length, 2);
  });
});
