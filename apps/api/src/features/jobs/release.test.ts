import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { logger } from "../../logger.js";
import { makeTestContext } from "../../test-support/context.js";
import { jobRoutes } from "./routes.js";

// docs/ai-jobs.md J53 / docs/api.md API36: a watcher shutting down mid-job hands
// the job back with POST /api/jobs/:id/release — back to the queue, claimable at
// once, without spending a retry; service-only like the rest of the lifecycle.

function watcher(): Principal {
  return {
    subject: "watcher@clients",
    scopes: ["manage:jobs", "read:knowledge"],
    roles: undefined,
    isService: true,
    payload: { gty: "client-credentials" }
  };
}

function human(): Principal {
  return { subject: "ops-admin", scopes: ["manage:jobs", "read:knowledge"], roles: [], isService: false, payload: {} };
}

function appFor(ctx: AppContext, who: Principal): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("logger", logger);
    c.set("authRequired", true);
    c.set("principal", who);
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

async function claimed(ctx: AppContext): Promise<string> {
  await ctx.jobs.create("summarize_gap", gapInput);
  const res = await post(appFor(ctx, watcher()), "/jobs/claim", claimBody);
  const { job } = (await res.json()) as { job: { id: string } | null };
  assert.ok(job, "the watcher should have claimed the queued job");
  return job.id;
}

describe("POST /jobs/:id/release (J53, API36)", () => {
  it("returns an active job to the queue without spending a retry, and it can be claimed again", async () => {
    const ctx = makeTestContext();
    const id = await claimed(ctx);
    const before = await ctx.jobs.get(id);
    const res = await post(appFor(ctx, watcher()), `/jobs/${id}/release`, { workerName: "w1" });
    assert.equal(res.status, 200);
    const { job } = (await res.json()) as { job: { state: string; retryCount: number } };
    assert.equal(job.state, "created");
    assert.equal(job.retryCount, before?.retryCount);

    const again = await post(appFor(ctx, watcher()), "/jobs/claim", claimBody);
    const reclaimed = (await again.json()) as { job: { id: string } | null };
    assert.equal(reclaimed.job?.id, id, "the released job is the next one claimed");
  });

  it("marks the releasing watcher idle in the registry", async () => {
    const ctx = makeTestContext();
    const id = await claimed(ctx);
    await post(appFor(ctx, watcher()), `/jobs/${id}/release`, { workerName: "w1" });
    const entry = (await ctx.stores.watchers.list(60_000)).find((w) => w.name === "w1");
    assert.equal(entry?.status, "idle");
  });

  it("is a no-op on a job that is no longer active (a cancel won the race)", async () => {
    const ctx = makeTestContext();
    const id = await claimed(ctx);
    await ctx.jobs.cancel(id);
    const res = await post(appFor(ctx, watcher()), `/jobs/${id}/release`, {});
    assert.equal(res.status, 200);
    assert.equal((await ctx.jobs.get(id))?.state, "cancelled");
  });

  it("404s an unknown job", async () => {
    const res = await post(
      appFor(makeTestContext(), watcher()),
      "/jobs/00000000-0000-4000-8000-000000000000/release",
      {}
    );
    assert.equal(res.status, 404);
  });

  it("denies a human manage:jobs holder (service-only, AZ29)", async () => {
    const ctx = makeTestContext();
    const id = await claimed(ctx);
    assert.equal((await post(appFor(ctx, human()), `/jobs/${id}/release`, {})).status, 403);
    assert.equal((await ctx.jobs.get(id))?.state, "active");
  });
});
