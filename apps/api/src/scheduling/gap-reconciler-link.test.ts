import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobType, JobView } from "@magpie/jobs";
import { FakeJobBroker } from "../jobs/fake-broker.js";
import { makeTestContext } from "../test-support/context.js";
import { reconcileGaps } from "./gap-reconciler.js";
import type { AppContext } from "../context.js";

// Completes every reshape at once with no verdicts. The reconciler does not wait
// on a reshape, and drafts only once one has been applied — this test is about
// drafting, so the reshape is made a no-op that is already done when enqueued.
class NoVerdictReshapeBroker extends FakeJobBroker {
  override async create(type: JobType, input: unknown): Promise<JobView> {
    const job = await super.create(type, input);
    return type === "reconcile_gap_clusters" ? super.complete(job.id, { merges: [], splits: [], dismissals: [] }) : job;
  }
}

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
    const ctx = makeTestContext({ jobs: new NoVerdictReshapeBroker() });
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
    // reconcile re-runs clustering + drafting.
    await seedClusterWithGap(ctx, "Credit notes");

    // Second reconcile: drafts the new cluster but NOT A again.
    await reconcileGaps(ctx, undefined, keepOpen);
    jobs = (await ctx.jobs.list({ type: "draft_markdown_proposal" })).jobs;
    assert.equal(draftJobsForCluster(jobs, clusterA), 1, "A is not re-drafted once it has a linked proposal");
  });
});
