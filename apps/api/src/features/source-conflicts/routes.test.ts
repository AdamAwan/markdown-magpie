import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { sourceConflictRoutes } from "./routes.js";

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
    c.set("authRequired", true);
    c.set("principal", who);
    await next();
  });
  app.route("/source-conflicts", sourceConflictRoutes(ctx));
  app.onError(onError);
  return app;
}

const positions = [
  { sourceId: "policy", path: "security/logging.md", statement: "retained for 1 year" },
  { sourceId: "ingest", path: "src/retention.ts", statement: "RETENTION_DAYS = 60" }
];

async function seed(ctx: AppContext, flowId: string, documentPath: string): Promise<string> {
  const { conflict } = await ctx.stores.sourceConflicts.upsert({
    flowId,
    documentPath,
    anchor: "retention",
    topic: "log retention period",
    summary: "One source states 1 year, another enforces 60 days.",
    claim: "Logs are retained for 1 year.",
    positions
  });
  return conflict.id;
}

describe("source-conflict routes", () => {
  it("lists conflicts and filters by status", async () => {
    const ctx = makeTestContext();
    const openId = await seed(ctx, "hr", "hr/leave.md");
    const dismissedId = await seed(ctx, "hr", "hr/other.md");
    await ctx.stores.sourceConflicts.dismiss(dismissedId, "not real");

    const res = await appFor(ctx, principal(undefined)).request("/source-conflicts?status=open");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { conflicts: Array<{ id: string }> };
    assert.deepEqual(
      body.conflicts.map((conflict) => conflict.id),
      [openId]
    );
  });

  it("dismisses a conflict with a note", async () => {
    const ctx = makeTestContext();
    const id = await seed(ctx, "hr", "hr/leave.md");

    const res = await appFor(ctx, principal(undefined)).request(`/source-conflicts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed", note: "the policy is authoritative here" })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; dismissalNote: string };
    assert.equal(body.status, "dismissed");
    assert.equal(body.dismissalNote, "the policy is authoritative here");
  });

  it("refuses to resolve a conflict by hand", async () => {
    // Resolution is evidence-based: the sources have to actually agree again.
    const ctx = makeTestContext();
    const id = await seed(ctx, "hr", "hr/leave.md");

    const res = await appFor(ctx, principal(undefined)).request(`/source-conflicts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" })
    });
    assert.equal(res.status, 400);
    assert.equal((await ctx.stores.sourceConflicts.get(id))?.status, "open");
  });

  it("returns 404 for an unknown conflict", async () => {
    const ctx = makeTestContext();
    const res = await appFor(ctx, principal(undefined)).request("/source-conflicts/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed" })
    });
    assert.equal(res.status, 404);
  });

  it("hides another flow's conflicts from the list", async () => {
    const ctx = makeTestContext();
    ctx.knowledgeConfig.roleGrants = { "kb-hr-curators": { hr: ["read", "manage"] } };
    const hrId = await seed(ctx, "hr", "hr/leave.md");
    await seed(ctx, "eng", "eng/deploy.md");

    const res = await appFor(ctx, principal(["kb-hr-curators"])).request("/source-conflicts");
    const body = (await res.json()) as { conflicts: Array<{ id: string }> };
    assert.deepEqual(
      body.conflicts.map((conflict) => conflict.id),
      [hrId]
    );
  });

  it("reads a cross-flow conflict as 404, not 403", async () => {
    const ctx = makeTestContext();
    ctx.knowledgeConfig.roleGrants = { "kb-hr-curators": { hr: ["read", "manage"] } };
    const engId = await seed(ctx, "eng", "eng/deploy.md");

    const res = await appFor(ctx, principal(["kb-hr-curators"])).request(`/source-conflicts/${engId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed" })
    });
    // A 403 would confirm the id exists.
    assert.equal(res.status, 404);
    assert.equal((await ctx.stores.sourceConflicts.get(engId))?.status, "open");
  });
});
