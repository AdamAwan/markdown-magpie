import { test } from "node:test";
import assert from "node:assert/strict";
import { jobDefinition } from "@magpie/jobs";
import { makeTestContext } from "../../test-support/context.js";
import { completeJob } from "../jobs/service.js";
import * as seed from "./service.js";

test("seedFlow enqueues one draft_seed_document per item, carrying flowId + coverage, honouring targetPath", async () => {
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

  const result = await seed.seedFlow(ctx, "billing", [
    { title: "Overview", targetPath: "overview.md", coverage: ["what it is", "why"] },
    { coverage: ["config options"] }
  ]);
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.jobIds.length, 2);

  const { jobs } = await ctx.jobs.list({ type: "draft_seed_document" });
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    const parsed = jobDefinition("draft_seed_document").inputSchema.safeParse(job.input);
    assert.ok(parsed.success, "enqueued input should match the draft_seed_document contract");
  }
  const first = jobs.find((job) => (job.input as { title?: string }).title === "Overview");
  assert.ok(first);
  const input = first?.input as { flowId?: string; targetPath?: string; coverage?: string[]; provider?: string };
  assert.equal(input.flowId, "billing");
  assert.equal(input.targetPath, "overview.md");
  assert.deepEqual(input.coverage, ["what it is", "why"]);
  assert.equal(input.provider, "codex");

  // Seeding never mints gap candidates.
  assert.deepEqual(await ctx.stores.questionLogs.listGapCandidates(200), []);
});

test("seedFlow rejects an unknown flow", async () => {
  const ctx = makeTestContext();
  const result = await seed.seedFlow(ctx, "no-such-flow", [{ coverage: ["x"] }]);
  assert.equal(result.ok, false);
  assert.deepEqual((await ctx.jobs.list({})).jobs, []);
});

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
