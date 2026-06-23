import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { reconcileDraftedProposal, applyFoldFromCompletedJob, enqueueFoldFallback } from "./fold.js";
import type { AppContext } from "../context.js";

async function clusterWithGap(ctx: AppContext, flowId: string | undefined, summary: string): Promise<string> {
  const log = await ctx.stores.questionLogs.record({
    question: `${summary}?`,
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, summary);
  const cluster = await ctx.stores.gapClusters.createCluster({ ...(flowId ? { flowId } : {}), title: summary, revision: 1 });
  const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary(summary);
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);
  return cluster.id;
}

async function draft(ctx: AppContext, opts: { targetPath: string; gapClusterId?: string }) {
  return ctx.stores.proposals.create({
    title: "T",
    targetPath: opts.targetPath,
    markdown: "# body",
    rationale: "r",
    evidence: [],
    ...(opts.gapClusterId ? { gapClusterId: opts.gapClusterId } : {})
  });
}

describe("reconcileDraftedProposal", () => {
  it("enqueues a fold job when a same-flow open proposal overlaps", async () => {
    const ctx = makeTestContext();
    await draft(ctx, { targetPath: "kb/refunds.md" }); // survivor A
    const rival = await draft(ctx, { targetPath: "kb/refunds.md" }); // rival B
    await reconcileDraftedProposal(ctx, rival);
    const jobs = (await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs;
    assert.equal(jobs.length, 1);
    assert.equal((jobs[0].input as { rivalProposalId: string }).rivalProposalId, rival.id);
  });

  it("does not fold when there is no overlap", async () => {
    const ctx = makeTestContext();
    await draft(ctx, { targetPath: "kb/a.md" });
    const rival = await draft(ctx, { targetPath: "kb/b.md" });
    await reconcileDraftedProposal(ctx, rival);
    assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 0);
  });

  it("does not fold across flows", async () => {
    const ctx = makeTestContext();
    const cA = await clusterWithGap(ctx, "flow-x", "A");
    const cB = await clusterWithGap(ctx, "flow-y", "B");
    await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cA });
    const rival = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cB });
    await reconcileDraftedProposal(ctx, rival);
    assert.equal((await ctx.jobs.list({ type: "fold_markdown_proposal" })).jobs.length, 0);
  });
});

describe("applyFoldFromCompletedJob", () => {
  it("updates survivor markdown, absorbs the rival cluster, supersedes the rival, and enqueues a publish", async () => {
    const ctx = makeTestContext();
    const cA = await clusterWithGap(ctx, undefined, "survivor");
    const cB = await clusterWithGap(ctx, undefined, "rival");
    const survivor = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cA });
    const rival = await draft(ctx, { targetPath: "kb/refunds.md", gapClusterId: cB });

    const job = await ctx.jobs.create("fold_markdown_proposal", {
      provider: "codex",
      survivorProposalId: survivor.id,
      rivalProposalId: rival.id,
      targetPath: "kb/refunds.md",
      survivorMarkdown: "# survivor",
      rivalMarkdown: "# rival",
      rivalGapSummaries: ["rival"],
      rivalEvidence: [],
      expectedOutput: "folded_markdown"
    });
    const stored = await ctx.jobs.get(job.id);
    await applyFoldFromCompletedJob(ctx, stored, { markdown: "# merged", rationale: "folded" });

    assert.equal((await ctx.stores.proposals.get(survivor.id))?.markdown, "# merged");
    assert.equal((await ctx.stores.proposals.get(rival.id))?.status, "superseded");
    assert.equal((await ctx.stores.gapClusters.getCluster(cB))?.status, "frozen");
    const survivorMembers = await ctx.stores.gapClusters.listMembershipsForCluster(cA);
    assert.equal(survivorMembers.length, 2, "rival's gap moved onto the survivor cluster");
    const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.ok(pending.some((a) => a.proposalId === survivor.id && a.kind === "publish"));
  });
});

describe("enqueueFoldFallback", () => {
  it("enqueues the rival's publish so the gap is not lost", async () => {
    const ctx = makeTestContext();
    const rival = await draft(ctx, { targetPath: "kb/refunds.md" });
    const job = await ctx.jobs.create("fold_markdown_proposal", {
      provider: "codex",
      survivorProposalId: "missing",
      rivalProposalId: rival.id,
      targetPath: "kb/refunds.md",
      survivorMarkdown: "x",
      rivalMarkdown: "y",
      rivalGapSummaries: [],
      rivalEvidence: [],
      expectedOutput: "folded_markdown"
    });
    await enqueueFoldFallback(ctx, await ctx.jobs.get(job.id));
    const pending = await ctx.stores.gapClusters.listPendingPublicationActions();
    assert.ok(pending.some((a) => a.proposalId === rival.id && a.kind === "publish"));
  });
});
