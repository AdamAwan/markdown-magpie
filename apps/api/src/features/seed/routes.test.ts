import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and we
// can exercise the seed endpoint's shape directly.

function seedRequest(app: ReturnType<typeof buildApp>, flowId: string, body: unknown) {
  return app.request(`/api/flows/${flowId}/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("POST /api/flows/:flowId/seed drafts one job per item and returns their ids", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "flow-x", name: "Flow X", sourceIds: [], destinationId: "kb" }];
  const app = buildApp(ctx);
  const res = await seedRequest(app, "flow-x", {
    items: [
      { title: "Overview", coverage: ["what it is"] },
      { coverage: ["config"] }
    ]
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; jobIds: string[] };
  assert.equal(body.ok, true);
  assert.equal(body.jobIds.length, 2);

  const { jobs } = await ctx.jobs.list({ type: "draft_seed_document" });
  assert.equal(jobs.length, 2);
});

test("POST /api/flows/:flowId/seed returns 404 for an unknown flow", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "flow-x", name: "Flow X", sourceIds: [], destinationId: "kb" }];
  const app = buildApp(ctx);
  const res = await seedRequest(app, "missing", { items: [{ coverage: ["x"] }] });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "flow_not_found" });
});

test("POST /api/flows/:flowId/seed returns 400 for an empty items array", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "flow-x", name: "Flow X", sourceIds: [], destinationId: "kb" }];
  const app = buildApp(ctx);
  const res = await seedRequest(app, "flow-x", { items: [] });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_seed_body" });
});

test("POST /api/flows/:flowId/seed returns 400 when an item has no coverage", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "flow-x", name: "Flow X", sourceIds: [], destinationId: "kb" }];
  const app = buildApp(ctx);
  const res = await seedRequest(app, "flow-x", { items: [{ title: "No coverage", coverage: [] }] });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_seed_body" });
});

function outlineRequest(app: ReturnType<typeof buildApp>, flowId: string, body: unknown) {
  return app.request(`/api/flows/${flowId}/outline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("POST /api/flows/:flowId/outline enqueues a planning job from notes only (no topic required)", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "flow-x", name: "Flow X", sourceIds: [], destinationId: "kb" }];
  const app = buildApp(ctx);
  const res = await outlineRequest(app, "flow-x", { notes: "partial refunds" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; jobId: string; reused: boolean };
  assert.equal(body.ok, true);
  assert.equal(typeof body.jobId, "string");
  assert.equal(body.reused, false);

  const { jobs } = await ctx.jobs.list({ type: "outline_flow_seed" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, body.jobId);
  const input = jobs[0].input as Record<string, unknown>;
  assert.equal(input.origin, "manual");
  assert.ok(!("topic" in input), "the planning input carries no topic");
});

test("POST /api/flows/:flowId/outline accepts an empty body", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "flow-x", name: "Flow X", sourceIds: [], destinationId: "kb" }];
  const app = buildApp(ctx);
  const res = await outlineRequest(app, "flow-x", {});
  assert.equal(res.status, 200);
  const { jobs } = await ctx.jobs.list({ type: "outline_flow_seed" });
  assert.equal(jobs.length, 1);
});

test("POST /api/flows/:flowId/outline returns 404 for an unknown flow", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "flow-x", name: "Flow X", sourceIds: [], destinationId: "kb" }];
  const app = buildApp(ctx);
  const res = await outlineRequest(app, "missing", { notes: "x" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "flow_not_found" });
});
