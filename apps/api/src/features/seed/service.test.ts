import { test } from "node:test";
import assert from "node:assert/strict";
import { jobDefinition } from "@magpie/jobs";
import { makeTestContext } from "../../test-support/context.js";
import { completeJob } from "../jobs/service.js";
import * as seed from "./service.js";

function billingFlowContext(): ReturnType<typeof makeTestContext> {
  return makeTestContext({
    knowledgeConfig: {
      sources: [{ id: "src-1", name: "Billing repo", kind: "git", url: "https://example.com/billing.git" }],
      destinations: [{ id: "docs", name: "Docs", kind: "local", path: "docs" }],
      flows: [
        {
          id: "billing",
          name: "Billing",
          sourceIds: ["src-1"],
          destinationId: "docs",
          persona: "Support agent",
          charter: "Everything a support agent needs about billing",
          routingSummary: "billing"
        }
      ],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
}

test("outlineFlowSeed enqueues a source-grounded planning job with flow config and no topic", async () => {
  const ctx = billingFlowContext();
  const result = await seed.outlineFlowSeed(ctx, "billing", { notes: "focus on partial refunds", origin: "manual" });
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.reused, false);

  const { jobs } = await ctx.jobs.list({ type: "outline_flow_seed" });
  assert.equal(jobs.length, 1);
  const parsed = jobDefinition("outline_flow_seed").inputSchema.safeParse(jobs[0].input);
  assert.ok(parsed.success, "enqueued input should match the outline_flow_seed contract");
  const input = jobs[0].input as {
    flowId?: string;
    origin?: string;
    notes?: string;
    sources?: { id: string }[];
    persona?: string;
    charter?: string;
    routingSummary?: string;
    existingDocuments?: unknown[];
    provider?: string;
  };
  assert.equal(input.flowId, "billing");
  assert.equal(input.origin, "manual");
  assert.equal(input.notes, "focus on partial refunds");
  assert.deepEqual(input.sources?.map((source) => source.id), ["src-1"]);
  assert.equal(input.persona, "Support agent");
  assert.equal(input.charter, "Everything a support agent needs about billing");
  assert.equal(input.routingSummary, "billing");
  assert.ok(Array.isArray(input.existingDocuments));
  assert.ok(!("topic" in (jobs[0].input as Record<string, unknown>)));
  assert.equal(input.provider, "codex");
  assert.equal(result.jobId, jobs[0].id);
});

test("outlineFlowSeed reuses an in-flight outline job for the same flow", async () => {
  const ctx = billingFlowContext();
  const first = await seed.outlineFlowSeed(ctx, "billing", { origin: "manual" });
  assert.ok(first.ok);
  if (!first.ok) throw new Error("unreachable");
  const second = await seed.outlineFlowSeed(ctx, "billing", { origin: "auto" });
  assert.ok(second.ok);
  if (!second.ok) throw new Error("unreachable");
  assert.equal(second.reused, true);
  assert.equal(second.jobId, first.jobId);
  const { jobs } = await ctx.jobs.list({ type: "outline_flow_seed" });
  assert.equal(jobs.length, 1);
});

test("outlineFlowSeed rejects an unknown flow", async () => {
  const ctx = makeTestContext();
  const result = await seed.outlineFlowSeed(ctx, "no-such-flow", { origin: "manual" });
  assert.equal(result.ok, false);
  assert.deepEqual((await ctx.jobs.list({})).jobs, []);
});

const outlineOutput = {
  items: [
    { title: "Runbook", targetPath: "runbook.md", coverage: ["how to restart"] },
    { title: "Alerts", coverage: ["alert routing"] }
  ],
  rationale: "Operations end to end."
};

async function completedOutlineJob(
  ctx: ReturnType<typeof makeTestContext>,
  input: Record<string, unknown> = {}
) {
  return ctx.jobs.create("outline_flow_seed", {
    provider: "codex",
    flowId: "billing",
    origin: "manual",
    sources: [{ id: "src-1", name: "Billing repo", kind: "git", url: "https://example.com/billing.git" }],
    existingDocuments: [],
    ...input
  });
}

test("createSeedPlanFromCompletedJob creates a proposed plan; input charter wins over the proposal", async () => {
  const ctx = billingFlowContext();
  const job = await completedOutlineJob(ctx, {
    charter: "Configured charter",
    persona: "Configured persona",
    notes: "steer"
  });
  const plan = await seed.createSeedPlanFromCompletedJob(ctx, job, {
    ...outlineOutput,
    proposedCharter: "Model charter",
    proposedPersona: "Model persona"
  });
  assert.ok(plan);
  assert.equal(plan?.status, "proposed");
  assert.equal(plan?.flowId, "billing");
  assert.equal(plan?.origin, "manual");
  assert.equal(plan?.charter, "Configured charter");
  assert.equal(plan?.persona, "Configured persona");
  assert.equal(plan?.charterProposed, false);
  assert.equal(plan?.personaProposed, false);
  assert.equal(plan?.notes, "steer");
  assert.equal(plan?.outlineJobId, job.id);
  assert.ok(plan?.sourceHash && plan.sourceHash.length > 0);
  assert.equal(plan?.items.length, 2);
  for (const item of plan?.items ?? []) {
    assert.ok(item.id.length > 0);
    assert.equal(item.status, "proposed");
  }
});

test("createSeedPlanFromCompletedJob falls back to proposedCharter/persona and flags them", async () => {
  const ctx = billingFlowContext();
  const job = await completedOutlineJob(ctx);
  const plan = await seed.createSeedPlanFromCompletedJob(ctx, job, {
    ...outlineOutput,
    proposedCharter: "Model charter",
    proposedPersona: "Model persona"
  });
  assert.equal(plan?.charter, "Model charter");
  assert.equal(plan?.charterProposed, true);
  assert.equal(plan?.persona, "Model persona");
  assert.equal(plan?.personaProposed, true);
});

test("createSeedPlanFromCompletedJob is idempotent on the job id", async () => {
  const ctx = billingFlowContext();
  const job = await completedOutlineJob(ctx);
  const first = await seed.createSeedPlanFromCompletedJob(ctx, job, outlineOutput);
  const second = await seed.createSeedPlanFromCompletedJob(ctx, job, outlineOutput);
  assert.equal(second?.id, first?.id);
  assert.equal((await ctx.stores.seedPlans.listByFlow("billing")).length, 1);
});

test("createSeedPlanFromCompletedJob supersedes an older proposed plan for the flow", async () => {
  const ctx = billingFlowContext();
  const firstJob = await completedOutlineJob(ctx);
  const first = await seed.createSeedPlanFromCompletedJob(ctx, firstJob, outlineOutput);
  const secondJob = await completedOutlineJob(ctx);
  const second = await seed.createSeedPlanFromCompletedJob(ctx, secondJob, outlineOutput);
  assert.ok(first && second && first.id !== second.id);
  assert.equal((await ctx.stores.seedPlans.get(first!.id))?.status, "superseded");
  assert.equal((await ctx.stores.seedPlans.get(second!.id))?.status, "proposed");
});

test("completing an outline job through the dispatcher persists the plan", async () => {
  const ctx = billingFlowContext();
  const job = await completedOutlineJob(ctx);
  const result = await completeJob(ctx, job.id, outlineOutput);
  assert.equal(result.ok, true);
  const plans = await ctx.stores.seedPlans.listByFlow("billing");
  assert.equal(plans.length, 1);
  assert.equal(plans[0].outlineJobId, job.id);
});

test("createSeedPlanFromCompletedJob ignores other job types and unparsable output", async () => {
  const ctx = billingFlowContext();
  const otherJob = await ctx.jobs.create("draft_seed_document", {
    provider: "codex",
    flowId: "billing",
    coverage: ["c"],
    sources: []
  });
  assert.equal(await seed.createSeedPlanFromCompletedJob(ctx, otherJob, outlineOutput), undefined);
  const outlineJob = await completedOutlineJob(ctx);
  assert.equal(await seed.createSeedPlanFromCompletedJob(ctx, outlineJob, { nonsense: true }), undefined);
  assert.equal(await seed.createSeedPlanFromCompletedJob(ctx, undefined, outlineOutput), undefined);
  assert.equal((await ctx.stores.seedPlans.listByFlow("billing")).length, 0);
});

async function proposedPlan(
  ctx: ReturnType<typeof makeTestContext>,
  output: unknown = outlineOutput,
  input: Record<string, unknown> = {}
) {
  const job = await completedOutlineJob(ctx, input);
  const plan = await seed.createSeedPlanFromCompletedJob(ctx, job, output);
  assert.ok(plan);
  if (!plan) throw new Error("unreachable");
  return plan;
}

test("approveSeedPlan enqueues one draft per non-dismissed item carrying charter/persona/seedPlanId", async () => {
  const ctx = billingFlowContext();
  // The outline input carried the flow config's charter/persona (the enqueue
  // path projects them), so the plan's run-scoped values are the config's.
  const plan = await proposedPlan(ctx, outlineOutput, {
    charter: "Everything a support agent needs about billing",
    persona: "Support agent"
  });
  const result = await seed.approveSeedPlan(ctx, plan.id);
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.jobIds.length, 2);
  assert.equal(result.plan.status, "approved");
  for (const item of result.plan.items) {
    assert.equal(item.status, "approved");
    assert.ok(item.draftJobId);
  }

  const { jobs } = await ctx.jobs.list({ type: "draft_seed_document" });
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    const parsed = jobDefinition("draft_seed_document").inputSchema.safeParse(job.input);
    assert.ok(parsed.success, "enqueued input should match the draft_seed_document contract");
    const input = job.input as Record<string, unknown>;
    assert.equal(input.flowId, "billing");
    assert.equal(input.charter, "Everything a support agent needs about billing");
    assert.equal(input.persona, "Support agent");
    assert.equal(input.seedPlanId, plan.id);
    assert.deepEqual((input.sources as { id: string }[]).map((source) => source.id), ["src-1"]);
    assert.equal(input.destinationId, "docs");
  }
});

test("approveSeedPlan skips dismissed items entirely", async () => {
  const ctx = billingFlowContext();
  const plan = await proposedPlan(ctx);
  await ctx.stores.seedPlans.patch(plan.id, { items: [{ id: plan.items[0].id, status: "dismissed" }] });
  const result = await seed.approveSeedPlan(ctx, plan.id);
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.jobIds.length, 1);
  const dismissed = result.plan.items.find((item) => item.id === plan.items[0].id);
  assert.equal(dismissed?.status, "dismissed");
  assert.equal(dismissed?.draftJobId, undefined);
});

test("approveSeedPlan replays: re-approving enqueues only items lacking a draftJobId", async () => {
  const ctx = billingFlowContext();
  const plan = await proposedPlan(ctx);
  // Simulate a mid-loop failure: one item already has its job recorded.
  await ctx.stores.seedPlans.setItemDraftJob(plan.id, plan.items[0].id, "already-enqueued");
  await ctx.stores.seedPlans.setStatus(plan.id, "approved");
  const result = await seed.approveSeedPlan(ctx, plan.id);
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.jobIds.length, 1);
  const { jobs } = await ctx.jobs.list({ type: "draft_seed_document" });
  assert.equal(jobs.length, 1);
  assert.equal(result.plan.items[0].draftJobId, "already-enqueued");
});

test("approveSeedPlan rejects when an approvable item has empty coverage and enqueues nothing", async () => {
  const ctx = billingFlowContext();
  const plan = await proposedPlan(ctx, {
    items: [{ title: "Empty", coverage: [] }, ...outlineOutput.items],
    rationale: "r"
  });
  const result = await seed.approveSeedPlan(ctx, plan.id);
  assert.deepEqual(result, { ok: false, code: "coverage_required" });
  assert.deepEqual((await ctx.jobs.list({ type: "draft_seed_document" })).jobs, []);
  assert.equal((await ctx.stores.seedPlans.get(plan.id))?.status, "proposed");
});

test("approveSeedPlan on a dismissed/superseded plan → plan_not_approvable; unknown → plan_not_found", async () => {
  const ctx = billingFlowContext();
  const plan = await proposedPlan(ctx);
  await ctx.stores.seedPlans.setStatus(plan.id, "dismissed");
  assert.deepEqual(await seed.approveSeedPlan(ctx, plan.id), { ok: false, code: "plan_not_approvable" });
  assert.deepEqual(await seed.approveSeedPlan(ctx, "no-such-plan"), { ok: false, code: "plan_not_found" });
});

test("patchSeedPlan edits while proposed; plan_not_editable once approved", async () => {
  const ctx = billingFlowContext();
  const plan = await proposedPlan(ctx);
  const patched = await seed.patchSeedPlan(ctx, plan.id, {
    charter: "Edited charter",
    items: [{ id: plan.items[0].id, coverage: ["edited"] }]
  });
  assert.ok(patched.ok);
  if (!patched.ok) throw new Error("unreachable");
  assert.equal(patched.plan.charter, "Edited charter");
  assert.deepEqual(patched.plan.items[0].coverage, ["edited"]);

  await ctx.stores.seedPlans.setStatus(plan.id, "approved");
  assert.deepEqual(await seed.patchSeedPlan(ctx, plan.id, { charter: "again" }), {
    ok: false,
    code: "plan_not_editable"
  });
  assert.deepEqual(await seed.patchSeedPlan(ctx, "no-such-plan", {}), { ok: false, code: "plan_not_found" });
});

test("dismissSeedPlan flips proposed → dismissed; anything else → plan_not_dismissable", async () => {
  const ctx = billingFlowContext();
  const plan = await proposedPlan(ctx);
  const dismissed = await seed.dismissSeedPlan(ctx, plan.id);
  assert.ok(dismissed.ok);
  if (!dismissed.ok) throw new Error("unreachable");
  assert.equal(dismissed.plan.status, "dismissed");
  assert.deepEqual(await seed.dismissSeedPlan(ctx, plan.id), { ok: false, code: "plan_not_dismissable" });
  assert.deepEqual(await seed.dismissSeedPlan(ctx, "no-such-plan"), { ok: false, code: "plan_not_found" });
});

test("listSeedPlans and getSeedPlan read plans back", async () => {
  const ctx = billingFlowContext();
  const plan = await proposedPlan(ctx);
  assert.deepEqual((await seed.listSeedPlans(ctx, "billing")).map((entry) => entry.id), [plan.id]);
  assert.equal((await seed.getSeedPlan(ctx, plan.id))?.id, plan.id);
  assert.equal(await seed.getSeedPlan(ctx, "no-such-plan"), undefined);
});
