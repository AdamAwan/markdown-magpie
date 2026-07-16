import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviseSeedPlanJobInput } from "@magpie/core";
import { jobDefinition, type JobView } from "@magpie/jobs";
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
  assert.deepEqual(
    input.sources?.map((source) => source.id),
    ["src-1"]
  );
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

async function completedOutlineJob(ctx: ReturnType<typeof makeTestContext>, input: Record<string, unknown> = {}) {
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
    assert.deepEqual(
      (input.sources as { id: string }[]).map((source) => source.id),
      ["src-1"]
    );
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

test("requestSeedPlanRevision enqueues a source-free revise job carrying the plan snapshot", async () => {
  const ctx = billingFlowContext();
  const plan = await proposedPlan(ctx);
  const outcome = await seed.requestSeedPlanRevision(ctx, plan.id, "don't mention alerts");
  assert.ok(outcome.ok);
  if (!outcome.ok) throw new Error("unreachable");
  const { jobs } = await ctx.jobs.list({ type: "revise_seed_plan" });
  assert.equal(jobs.length, 1);
  const parsed = jobDefinition("revise_seed_plan").inputSchema.safeParse(jobs[0].input);
  assert.ok(parsed.success, "enqueued input should match the revise_seed_plan contract");
  const input = jobs[0].input as ReviseSeedPlanJobInput & { provider?: string };
  assert.equal(input.planId, plan.id);
  assert.equal(input.flowId, "billing");
  assert.equal(input.instruction, "don't mention alerts");
  assert.equal(input.currentPlan.items.length, plan.items.length);
  assert.equal(input.provider, "codex");
  // Reshape-only: the job never re-reads sources.
  assert.ok(!("sources" in (jobs[0].input as Record<string, unknown>)));
  assert.equal(outcome.jobId, jobs[0].id);
});

test("requestSeedPlanRevision rejects a non-proposed plan and an unknown plan", async () => {
  const ctx = billingFlowContext();
  const plan = await proposedPlan(ctx);
  await ctx.stores.seedPlans.setStatus(plan.id, "approved");
  assert.deepEqual(await seed.requestSeedPlanRevision(ctx, plan.id, "x"), { ok: false, code: "plan_not_revisable" });
  assert.deepEqual(await seed.requestSeedPlanRevision(ctx, "no-such-plan", "x"), { ok: false, code: "plan_not_found" });
  assert.deepEqual((await ctx.jobs.list({ type: "revise_seed_plan" })).jobs, []);
});

function reviseJobFor(planId: string): JobView {
  return {
    id: "revise-job-1",
    type: "revise_seed_plan",
    input: { planId, flowId: "billing", instruction: "x", currentPlan: { items: [], rationale: "r" } }
  } as unknown as JobView;
}

test("reviseSeedPlanFromCompletedJob applies items/charter to a still-proposed plan in place", async () => {
  const ctx = billingFlowContext();
  const plan = await proposedPlan(ctx);
  const updated = await seed.reviseSeedPlanFromCompletedJob(ctx, reviseJobFor(plan.id), {
    items: [{ title: "Only", coverage: ["one point"] }],
    rationale: "Reshaped",
    charter: "Narrowed charter"
  });
  assert.ok(updated);
  if (!updated) throw new Error("unreachable");
  assert.equal(updated.id, plan.id);
  assert.equal(updated.items.length, 1);
  assert.equal(updated.items[0].title, "Only");
  assert.equal(updated.items[0].status, "proposed");
  assert.equal(updated.rationale, "Reshaped");
  assert.equal(updated.charter, "Narrowed charter");
  assert.equal(updated.status, "proposed");
});

test("reviseSeedPlanFromCompletedJob ignores non-proposed plans, other types, missing plan, unparsable output", async () => {
  const ctx = billingFlowContext();
  const approved = await proposedPlan(ctx);
  await ctx.stores.seedPlans.setStatus(approved.id, "approved");
  assert.equal(
    await seed.reviseSeedPlanFromCompletedJob(ctx, reviseJobFor(approved.id), { items: [], rationale: "r" }),
    undefined
  );
  const other = { id: "j", type: "outline_flow_seed", input: {} } as unknown as JobView;
  assert.equal(await seed.reviseSeedPlanFromCompletedJob(ctx, other, { items: [], rationale: "r" }), undefined);
  const proposed = await proposedPlan(ctx);
  assert.equal(
    await seed.reviseSeedPlanFromCompletedJob(ctx, reviseJobFor(proposed.id), { nonsense: true }),
    undefined
  );
  assert.equal(
    await seed.reviseSeedPlanFromCompletedJob(ctx, reviseJobFor("no-such-plan"), { items: [], rationale: "r" }),
    undefined
  );
  assert.equal(await seed.reviseSeedPlanFromCompletedJob(ctx, undefined, { items: [], rationale: "r" }), undefined);
});

test("runSeedBootstrap no-ops with no_sources for a flow without sources", async () => {
  const ctx = makeTestContext({
    knowledgeConfig: {
      sources: [],
      destinations: [{ id: "docs", name: "Docs", kind: "local", path: "docs" }],
      flows: [{ id: "billing", name: "Billing", sourceIds: [], destinationId: "docs" }],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
  const result = await seed.runSeedBootstrap(ctx, "billing");
  assert.deepEqual(result, { ok: true, enqueued: false, reason: "no_sources" });
  assert.deepEqual((await ctx.jobs.list({})).jobs, []);
});

test("runSeedBootstrap no-ops with kb_populated when the destination has enough docs", async () => {
  const ctx = billingFlowContext();
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    documents: ["a.md", "b.md", "c.md"].map((path) => ({ path, content: `# ${path}` })),
    repositoryId: "docs"
  });
  const result = await seed.runSeedBootstrap(ctx, "billing");
  assert.deepEqual(result, { ok: true, enqueued: false, reason: "kb_populated" });
});

test("runSeedBootstrap no-ops with plan_pending when a proposed plan exists", async () => {
  const ctx = billingFlowContext();
  await proposedPlan(ctx);
  const result = await seed.runSeedBootstrap(ctx, "billing");
  assert.deepEqual(result, { ok: true, enqueued: false, reason: "plan_pending" });
});

test("runSeedBootstrap no-ops with outline_in_flight when an outline job is pending", async () => {
  const ctx = billingFlowContext();
  const outline = await seed.outlineFlowSeed(ctx, "billing", { origin: "manual" });
  assert.ok(outline.ok);
  const result = await seed.runSeedBootstrap(ctx, "billing");
  assert.deepEqual(result, { ok: true, enqueued: false, reason: "outline_in_flight" });
});

test("runSeedBootstrap no-ops with seed_proposals_open when a plan's proposal is still open", async () => {
  const ctx = billingFlowContext();
  await ctx.stores.proposals.create({
    title: "Runbook",
    targetPath: "runbook.md",
    markdown: "# Runbook",
    rationale: "seed",
    evidence: [],
    flowId: "billing",
    seedPlanId: "plan-1"
  });
  const result = await seed.runSeedBootstrap(ctx, "billing");
  assert.deepEqual(result, { ok: true, enqueued: false, reason: "seed_proposals_open" });
});

test("runSeedBootstrap no-ops with dismissed_unchanged while the sources match the dismissed plan", async () => {
  const ctx = billingFlowContext();
  // The dismissed plan's sourceHash must match the flow's CURRENT sources, so
  // build it through the real enqueue → completion path, then dismiss.
  const outline = await seed.outlineFlowSeed(ctx, "billing", { origin: "manual" });
  assert.ok(outline.ok);
  if (!outline.ok) throw new Error("unreachable");
  const job = await ctx.jobs.get(outline.jobId);
  const plan = await seed.createSeedPlanFromCompletedJob(ctx, job, outlineOutput);
  assert.ok(plan);
  await ctx.jobs.cancel(outline.jobId);
  await ctx.stores.seedPlans.setStatus(plan!.id, "dismissed");

  const result = await seed.runSeedBootstrap(ctx, "billing");
  assert.deepEqual(result, { ok: true, enqueued: false, reason: "dismissed_unchanged" });
});

test("runSeedBootstrap enqueues an auto-origin outline when every guard passes", async () => {
  const ctx = billingFlowContext();
  const result = await seed.runSeedBootstrap(ctx, "billing");
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.enqueued, true);
  assert.ok(result.outlineJobId);
  const { jobs } = await ctx.jobs.list({ type: "outline_flow_seed" });
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0].input as { origin?: string }).origin, "auto");
});

test("runSeedBootstrap re-proposes when the dismissed plan's hash differs from the current sources", async () => {
  const ctx = billingFlowContext();
  // A dismissed plan whose sourceHash reflects DIFFERENT sources than the flow
  // has now (the operator re-pointed the flow since the human said no).
  const plan = await proposedPlan(ctx, outlineOutput, {
    sources: [{ id: "old-src", name: "Old", kind: "git", url: "https://example.com/old.git" }]
  });
  await ctx.jobs.cancel(plan.outlineJobId);
  await ctx.stores.seedPlans.setStatus(plan.id, "dismissed");

  const result = await seed.runSeedBootstrap(ctx, "billing");
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.enqueued, true);
});

test("runSeedBootstrap 404s an unknown flow", async () => {
  const ctx = makeTestContext();
  assert.deepEqual(await seed.runSeedBootstrap(ctx, "no-such-flow"), { ok: false, code: "flow_not_found" });
});

test("listSeedPlans and getSeedPlan read plans back", async () => {
  const ctx = billingFlowContext();
  const plan = await proposedPlan(ctx);
  assert.deepEqual(
    (await seed.listSeedPlans(ctx, "billing")).map((entry) => entry.id),
    [plan.id]
  );
  assert.equal((await seed.getSeedPlan(ctx, plan.id))?.id, plan.id);
  assert.equal(await seed.getSeedPlan(ctx, "no-such-plan"), undefined);
});
