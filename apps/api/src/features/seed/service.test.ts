import { test } from "node:test";
import assert from "node:assert/strict";
import { jobDefinition } from "@magpie/jobs";
import { makeTestContext } from "../../test-support/context.js";
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
      sources: [],
      destinations: [{ id: "docs", name: "Docs", kind: "local", path: "docs" }],
      flows: [{ id: "billing", name: "Billing", sourceIds: [], destinationId: "docs", persona: "Support agent" }],
      repositories: [],
      roleGrants: {},
      checkoutRoot: ".magpie/checkouts"
    }
  });
}

test("outlineFlowSeed enqueues an outline_flow_seed job carrying flowId + topic + persona", async () => {
  const ctx = billingFlowContext();
  const result = await seed.outlineFlowSeed(ctx, "billing", { topic: "Refunds", notes: "focus on partial refunds" });
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");

  const { jobs } = await ctx.jobs.list({ type: "outline_flow_seed" });
  assert.equal(jobs.length, 1);
  const parsed = jobDefinition("outline_flow_seed").inputSchema.safeParse(jobs[0].input);
  assert.ok(parsed.success, "enqueued input should match the outline_flow_seed contract");
  const input = jobs[0].input as {
    flowId?: string;
    topic?: string;
    notes?: string;
    persona?: string;
    existingDocuments?: unknown[];
    provider?: string;
  };
  assert.equal(input.flowId, "billing");
  assert.equal(input.topic, "Refunds");
  assert.equal(input.notes, "focus on partial refunds");
  assert.equal(input.persona, "Support agent");
  assert.ok(Array.isArray(input.existingDocuments));
  assert.equal(input.provider, "codex");
  assert.equal(result.jobId, jobs[0].id);
});

test("outlineFlowSeed rejects an unknown flow", async () => {
  const ctx = makeTestContext();
  const result = await seed.outlineFlowSeed(ctx, "no-such-flow", { topic: "x" });
  assert.equal(result.ok, false);
  assert.deepEqual((await ctx.jobs.list({})).jobs, []);
});

test("outlineFlowSeed rejects an empty topic", async () => {
  const ctx = billingFlowContext();
  const result = await seed.outlineFlowSeed(ctx, "billing", { topic: "   " });
  assert.equal(result.ok, false);
  assert.deepEqual((await ctx.jobs.list({})).jobs, []);
});
