import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../../test-support/context.js";
import { completeJob, createJob } from "../jobs/service.js";

const gitSource = { id: "s1", name: "Source One", kind: "git" as const, url: "https://example.com/repo.git" };

async function completedVerifyJob(ctx: ReturnType<typeof makeTestContext>, mapUpdates: unknown[]) {
  const job = await createJob(ctx, "verify_document", {
    provider: "codex",
    path: "doc.md",
    content: "# Doc",
    sources: [gitSource]
  });
  return completeJob(ctx, job.id, { verdict: "healthy", claims: [], mapUpdates });
}

describe("applySourceMapUpdatesFromCompletedJob (via completeJob)", () => {
  it("upserts valid mapUpdates from a completed source-grounded job", async () => {
    const ctx = makeTestContext();
    const result = await completedVerifyJob(ctx, [
      { sourceId: "s1", topic: "event system", paths: ["src/events/"], description: "Event bus lives here", observedSha: "abc123" }
    ]);
    assert.equal(result.ok, true);
    const entries = await ctx.stores.sourceMap.listBySource("s1", 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].topic, "event system");
    assert.equal(entries[0].observedSha, "abc123");
  });

  it("drops updates for sources the job was not grounded in", async () => {
    const ctx = makeTestContext();
    const result = await completedVerifyJob(ctx, [
      { sourceId: "somebody-else", topic: "t", paths: ["p/"], description: "d" }
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(await ctx.stores.sourceMap.listBySource("somebody-else", 10), []);
  });

  it("drops oversized updates without failing the completion", async () => {
    const ctx = makeTestContext();
    const result = await completedVerifyJob(ctx, [
      { sourceId: "s1", topic: "t", paths: ["p/"], description: "x".repeat(500) }
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(await ctx.stores.sourceMap.listBySource("s1", 10), []);
  });

  it("evicts oldest entries beyond the 200-per-source cap after applying updates", async () => {
    const ctx = makeTestContext();
    for (let i = 0; i < 200; i++) {
      await ctx.stores.sourceMap.upsert({ sourceId: "s1", topic: `seeded-${i}`, paths: ["p/"], description: "d" });
    }
    const result = await completedVerifyJob(ctx, [
      { sourceId: "s1", topic: "fresh", paths: ["q/"], description: "newest" }
    ]);
    assert.equal(result.ok, true);
    const entries = await ctx.stores.sourceMap.listBySource("s1", 500);
    assert.equal(entries.length, 200);
    assert.ok(entries.some((e) => e.topic === "fresh"));
  });

  it("rejects mapUpdates with an empty paths array", async () => {
    const ctx = makeTestContext();
    const result = await completedVerifyJob(ctx, [
      { sourceId: "s1", topic: "t", paths: [], description: "d" }
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_output");
    assert.deepEqual(await ctx.stores.sourceMap.listBySource("s1", 10), []);
  });

  it("rejects mapUpdates with an empty string in paths", async () => {
    const ctx = makeTestContext();
    const result = await completedVerifyJob(ctx, [
      { sourceId: "s1", topic: "t", paths: [""], description: "d" }
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_output");
    assert.deepEqual(await ctx.stores.sourceMap.listBySource("s1", 10), []);
  });

  it("applies mapUpdates from a completed outline_flow_seed job", async () => {
    const ctx = makeTestContext();
    const job = await createJob(ctx, "outline_flow_seed", {
      provider: "codex",
      flowId: "f1",
      origin: "manual",
      sources: [gitSource],
      existingDocuments: []
    });
    const result = await completeJob(ctx, job.id, {
      items: [{ title: "Runbook", coverage: ["restarts"] }],
      rationale: "r",
      mapUpdates: [{ sourceId: "s1", topic: "restarts", paths: ["ops/"], description: "Runbooks live here" }]
    });
    assert.equal(result.ok, true);
    const entries = await ctx.stores.sourceMap.listBySource("s1", 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].topic, "restarts");
  });

  it("ignores non-source-grounded job types", async () => {
    const ctx = makeTestContext();
    const job = await createJob(ctx, "summarize_gap", {
      provider: "codex",
      questions: ["q"],
      citedSections: [],
      expectedOutput: "gap_summary"
    });
    const result = await completeJob(ctx, job.id, { summary: "s", priority: 1, rationale: "r" });
    assert.equal(result.ok, true);
    assert.deepEqual(await ctx.stores.sourceMap.listBySource("s1", 10), []);
  });
});
