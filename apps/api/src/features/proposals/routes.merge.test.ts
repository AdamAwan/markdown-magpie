import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { proposalRoutes } from "./routes.js";

function principal(): Principal {
  return { subject: "auth0|tester", scopes: ["read:knowledge", "manage:knowledge"], roles: undefined, payload: {} };
}

function appFor(ctx: AppContext): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authRequired", true);
    c.set("principal", principal());
    await next();
  });
  app.route("/proposals", proposalRoutes(ctx));
  app.onError(onError);
  return app;
}

function ctxWithDestination(url: string): AppContext {
  return makeTestContext({
    knowledgeConfig: {
      sources: [],
      destinations: [{ id: "demo", name: "Demo", url, kind: "git" }],
      flows: [],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
}

async function seedBranchPushed(ctx: AppContext): Promise<string> {
  const created = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# X\n",
    rationale: "r",
    evidence: [],
    destinationId: "demo"
  });
  await ctx.stores.proposals.recordPublication(created.id, {
    provider: "local-git",
    branchName: "magpie/proposal-abc",
    commitSha: "deadbeef",
    remoteUrl: "https://github.com/o/r.git",
    publishedAt: new Date().toISOString()
  });
  return created.id;
}

describe("POST /proposals/:id/merge", () => {
  it("404s for an unknown proposal", async () => {
    const res = await appFor(ctxWithDestination("https://github.com/o/r.git")).request("/proposals/nope/merge", {
      method: "POST"
    });
    assert.equal(res.status, 404);
  });

  it("409s a hosted destination", async () => {
    const ctx = ctxWithDestination("https://github.com/o/r.git");
    const id = await seedBranchPushed(ctx);
    const res = await appFor(ctx).request(`/proposals/${id}/merge`, { method: "POST" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "not_local_git_destination");
  });
});
