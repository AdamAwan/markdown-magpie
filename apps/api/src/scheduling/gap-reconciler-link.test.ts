import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { reconcileGaps } from "./gap-reconciler.js";
import type { AppContext } from "../context.js";

const keepOpen = {
  fetchPullRequestStatus: async () => ({ merged: false, state: "open" as const, mergeable: "unknown" as const })
};

async function seedClusterWithGap(ctx: AppContext, summary: string): Promise<string> {
  const log = await ctx.stores.questionLogs.record({
    question: `${summary}?`,
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, summary);
  const cluster = await ctx.stores.gapClusters.createCluster({ title: summary, revision: 1 });
  const [gapId] = await ctx.stores.questionLogs.gapIdsForSummary(summary);
  await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId);
  return cluster.id;
}

function draftJobsForCluster(jobs: { input: unknown }[], clusterId: string): number {
  return jobs.filter((j) => (j.input as { gapClusterId?: string }).gapClusterId === clusterId).length;
}

describe("autonomous drafts are not re-drafted once linked", () => {
  it("does not enqueue a second draft for a cluster that already has a linked proposal", async () => {
    const ctx = makeTestContext();
    const clusterA = await seedClusterWithGap(ctx, "Refunds");

    // First reconcile: drafts cluster A (one draft job carrying gapClusterId=A).
    await reconcileGaps(ctx, undefined, keepOpen);
    let jobs = (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs;
    assert.equal(draftJobsForCluster(jobs, clusterA), 1, "A drafted once");

    // Simulate that draft completing into a linked proposal (what
    // createProposalFromCompletedJob does once the watcher finishes).
    await ctx.stores.proposals.create({
      title: "Refunds",
      targetPath: "kb/refunds.md",
      markdown: "# Refunds",
      rationale: "r",
      evidence: [],
      triggeringQuestionIds: [],
      gapClusterId: clusterA
    });

    // A new gap in a different cluster bumps the catalog revision so the next
    // reconcile re-runs clustering + drafting. With two clusters, the reshape job
    // will be enqueued but FakeJobBroker never completes it; use a short timeout so
    // requestReshape's bounded-wait resolves quickly and drafting still runs.
    ctx.settings.jobs.runToCompletionTimeoutMs = 20;
    await seedClusterWithGap(ctx, "Credit notes");

    // Second reconcile: drafts the new cluster but NOT A again.
    await reconcileGaps(ctx, undefined, keepOpen);
    jobs = (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs;
    assert.equal(draftJobsForCluster(jobs, clusterA), 1, "A is not re-drafted once it has a linked proposal");
  });
});
