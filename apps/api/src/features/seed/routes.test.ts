import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";
import { createSeedPlanFromCompletedJob } from "./service.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and we
// can exercise the seed endpoints' shape directly.

function flowContext() {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "flow-x", name: "Flow X", sourceIds: [], destinationId: "kb" }];
  return ctx;
}

async function proposedPlan(ctx: ReturnType<typeof makeTestContext>) {
  const job = await ctx.jobs.create("outline_flow_seed", {
    provider: "codex",
    flowId: "flow-x",
    origin: "manual",
    sources: [],
    existingDocuments: []
  });
  const plan = await createSeedPlanFromCompletedJob(ctx, job, {
    items: [{ title: "Runbook", coverage: ["restarts"] }],
    rationale: "r",
    proposedCharter: "Cover operations"
  });
  assert.ok(plan);
  if (!plan) throw new Error("unreachable");
  return plan;
}

function outlineRequest(app: ReturnType<typeof buildApp>, flowId: string, body: unknown) {
  return app.request(`/api/flows/${flowId}/outline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("POST /api/flows/:flowId/outline enqueues a planning job from notes only (no topic required)", async () => {
  const ctx = flowContext();
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
  const ctx = flowContext();
  const app = buildApp(ctx);
  const res = await outlineRequest(app, "flow-x", {});
  assert.equal(res.status, 200);
  const { jobs } = await ctx.jobs.list({ type: "outline_flow_seed" });
  assert.equal(jobs.length, 1);
});

test("POST /api/flows/:flowId/outline returns 404 for an unknown flow", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const res = await outlineRequest(app, "missing", { notes: "x" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "flow_not_found" });
});

test("the legacy raw-seed endpoint is gone", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const res = await app.request("/api/flows/flow-x/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ coverage: ["x"] }] })
  });
  assert.equal(res.status, 404);
});

test("GET /api/flows/:flowId/seed-plans lists plans; unknown flow 404s", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const plan = await proposedPlan(ctx);

  const res = await app.request("/api/flows/flow-x/seed-plans");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { plans: { id: string }[] };
  assert.deepEqual(body.plans.map((entry) => entry.id), [plan.id]);

  assert.equal((await app.request("/api/flows/missing/seed-plans")).status, 404);
});

test("GET /api/seed-plans/:id returns the plan; unknown ids 404", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const plan = await proposedPlan(ctx);

  const res = await app.request(`/api/seed-plans/${plan.id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { plan: { id: string; charterProposed: boolean } };
  assert.equal(body.plan.id, plan.id);
  assert.equal(body.plan.charterProposed, true);

  assert.equal((await app.request("/api/seed-plans/no-such-plan")).status, 404);
});

test("PATCH /api/seed-plans/:id edits while proposed and 409s once approved", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const plan = await proposedPlan(ctx);

  const res = await app.request(`/api/seed-plans/${plan.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ charter: "Edited", items: [{ id: plan.items[0].id, coverage: ["edited"] }] })
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { plan: { charter: string; items: { coverage: string[] }[] } };
  assert.equal(body.plan.charter, "Edited");
  assert.deepEqual(body.plan.items[0].coverage, ["edited"]);

  await ctx.stores.seedPlans.setStatus(plan.id, "approved");
  const conflict = await app.request(`/api/seed-plans/${plan.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ charter: "again" })
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "plan_not_editable" });
});

test("POST /api/seed-plans/:id/approve returns jobIds; approving a dismissed plan 409s", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const plan = await proposedPlan(ctx);

  const res = await app.request(`/api/seed-plans/${plan.id}/approve`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { plan: { status: string }; jobIds: string[] };
  assert.equal(body.plan.status, "approved");
  assert.equal(body.jobIds.length, 1);
  assert.equal((await ctx.jobs.list({ type: "draft_seed_document" })).jobs.length, 1);

  const dismissedPlan = await (async () => {
    const second = await ctx.jobs.create("outline_flow_seed", {
      provider: "codex",
      flowId: "flow-x",
      origin: "manual",
      sources: [],
      existingDocuments: []
    });
    return createSeedPlanFromCompletedJob(ctx, second, { items: [{ coverage: ["c"] }], rationale: "r" });
  })();
  assert.ok(dismissedPlan);
  await ctx.stores.seedPlans.setStatus(dismissedPlan!.id, "dismissed");
  const conflict = await app.request(`/api/seed-plans/${dismissedPlan!.id}/approve`, { method: "POST" });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "plan_not_approvable" });
});

test("POST /api/seed-plans/:id/dismiss flips proposed plans and 409s otherwise", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const plan = await proposedPlan(ctx);

  const res = await app.request(`/api/seed-plans/${plan.id}/dismiss`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { plan: { status: string } };
  assert.equal(body.plan.status, "dismissed");

  const again = await app.request(`/api/seed-plans/${plan.id}/dismiss`, { method: "POST" });
  assert.equal(again.status, 409);
});
