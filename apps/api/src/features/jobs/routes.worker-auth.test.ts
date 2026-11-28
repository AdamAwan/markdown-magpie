import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { resolveEffectivePrincipal, ON_BEHALF_OF_SCOPE, type Principal } from "@magpie/auth";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { logger } from "../../logger.js";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";
import { jobRoutes } from "./routes.js";

// docs/authorization.md AZ29: the watcher's job-lifecycle endpoints accept only
// genuine service principals. A human operator holds manage:jobs too, but must not
// claim jobs (reading their inputs) or post completions/failures for them.

function human(): Principal {
  return { subject: "ops-admin", scopes: ["manage:jobs", "read:knowledge"], roles: [], isService: false, payload: {} };
}

function watcher(): Principal {
  return {
    subject: "watcher@clients",
    scopes: ["manage:jobs", "read:knowledge"],
    roles: undefined,
    isService: true,
    payload: { gty: "client-credentials" }
  };
}

function appFor(ctx: AppContext, who: Principal | undefined, authRequired = true): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("logger", logger);
    c.set("authRequired", authRequired);
    if (who) c.set("principal", who);
    await next();
  });
  app.route("/jobs", jobRoutes(ctx));
  app.onError(onError);
  return app;
}

async function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

const claimBody = { workerName: "w1", capabilities: ["codex"] };
const gapInput = {
  provider: "codex" as const,
  questions: ["Q?"],
  citedSections: [],
  expectedOutput: "gap_summary" as const
};
const failBody = { error: { code: "boom", message: "boom", category: "internal" } };

async function claimedJobId(ctx: AppContext): Promise<string> {
  await ctx.jobs.create("summarize_gap", gapInput);
  const res = await post(appFor(ctx, watcher()), "/jobs/claim", claimBody);
  const { job } = (await res.json()) as { job: { id: string } | null };
  assert.ok(job, "the watcher should have claimed the queued job");
  return job.id;
}

describe("watcher job-lifecycle endpoints are service-only (AZ29)", () => {
  it("deny a human manage:jobs holder on claim / heartbeat / complete / fail", async () => {
    const ctx = makeTestContext();
    const id = await claimedJobId(ctx);
    const app = appFor(ctx, human());
    assert.equal((await post(app, "/jobs/claim", claimBody)).status, 403);
    assert.equal((await post(app, `/jobs/${id}/heartbeat`, { workerName: "w1" })).status, 403);
    assert.equal((await post(app, `/jobs/${id}/complete`, { output: { summary: "forged" } })).status, 403);
    assert.equal((await post(app, `/jobs/${id}/fail`, failBody)).status, 403);
    // The forged outcomes never landed.
    assert.equal((await ctx.jobs.get(id))?.state, "active");
  });

  it("deny an on-behalf-of delegated principal (it stands for the end user)", async () => {
    const mcp: Principal = { ...watcher(), scopes: [...watcher().scopes, ON_BEHALF_OF_SCOPE] };
    const delegated = resolveEffectivePrincipal(mcp, { subject: "alice", roles: "[]" });
    const res = await post(appFor(makeTestContext(), delegated), "/jobs/claim", claimBody);
    assert.equal(res.status, 403);
  });

  it("deny a principal-absent request when auth is required", async () => {
    const res = await post(appFor(makeTestContext(), undefined), "/jobs/claim", claimBody);
    assert.equal(res.status, 401);
  });

  it("allow a genuine service principal through the whole lifecycle", async () => {
    const ctx = makeTestContext();
    const id = await claimedJobId(ctx);
    const app = appFor(ctx, watcher());
    assert.equal((await post(app, `/jobs/${id}/heartbeat`, { workerName: "w1" })).status, 200);
    assert.equal((await post(app, `/jobs/${id}/fail`, failBody)).status, 200);
  });

  it("keep working with auth disabled (local dev, e2e)", async () => {
    const ctx = makeTestContext();
    await ctx.jobs.create("summarize_gap", gapInput);
    const app = buildApp(ctx);
    const res = await post(app, "/api/jobs/claim", claimBody);
    assert.equal(res.status, 200);
    const { job } = (await res.json()) as { job: { id: string } | null };
    assert.ok(job);
    assert.equal((await post(app, `/api/jobs/${job.id}/heartbeat`, {})).status, 200);
  });

  it("leave operator job management to humans (cancel is not service-only)", async () => {
    const ctx = makeTestContext();
    const created = await ctx.jobs.create("summarize_gap", gapInput);
    const res = await post(appFor(ctx, human()), `/jobs/${created.id}/cancel`, {});
    assert.equal(res.status, 200);
  });
});
