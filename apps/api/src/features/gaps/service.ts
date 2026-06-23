import type { GapCandidate, PersistedGapCluster } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { collectOpenPullRequestContext, draftFromGaps, type SourceContextCache } from "../proposals/service.js";
import { reconcileGaps as runReconcileGaps } from "../../scheduling/gap-reconciler.js";

export async function listCandidates(ctx: AppContext, limit: number): Promise<GapCandidate[]> {
  return ctx.stores.questionLogs.listGapCandidates(limit);
}

// Runs the full gap→PR reconciliation for one flow (clustering, the reshape AI job
// the API bounded-waits on, drafting and publication enqueue). This is the thin
// endpoint the maintenance watcher's process_gaps_to_pull_requests runner POSTs;
// the heavy orchestration stays here in the API. An absent flowId reconciles the
// default/un-routed flow.
export async function reconcileFlow(ctx: AppContext, flowId: string | undefined): Promise<void> {
  await runReconcileGaps(ctx, flowId);
}

// Fast read over the persisted clusters the reconciler maintains — no model call.
// Each active cluster is enriched with its gap summaries/question ids and the
// proposal (if any) linked to it, matching the SuggestedGapCluster fields the UI
// already renders plus the persisted lineage fields.
export async function listClusters(ctx: AppContext, limit: number): Promise<PersistedGapCluster[]> {
  const clusters = await ctx.stores.gapClusters.listActiveClusters();
  const proposals = await ctx.stores.proposals.list(500);
  const proposalByCluster = new Map(
    proposals.filter((p) => p.gapClusterId).map((p) => [p.gapClusterId as string, p])
  );

  const result: PersistedGapCluster[] = [];
  for (const cluster of clusters.slice(0, limit)) {
    const memberships = await ctx.stores.gapClusters.listMembershipsForCluster(cluster.id);
    const gapIds = memberships.map((m) => m.gapId);
    const { summaries, questionIds } = await ctx.stores.questionLogs.gapDetailsForIds(gapIds);
    const proposal = proposalByCluster.get(cluster.id);
    result.push({
      id: cluster.id,
      title: cluster.title,
      summaries,
      questionIds,
      count: questionIds.length,
      rationale: cluster.rationale,
      flowId: cluster.flowId,
      status: "active",
      proposalId: proposal?.id,
      proposalStatus: proposal?.status,
      lastReconciledAt: cluster.updatedAt
    });
  }
  return result;
}

// Drafts one proposal from a persisted cluster. The cluster's own flow routes the
// draft, so the caller only supplies optional target/destination overrides.
// Drafting is enqueue-only: the proposal is created later by the AI-job completion
// path, which links it back to its cluster.
export async function draftFromCluster(
  ctx: AppContext,
  clusterId: string,
  overrides: { targetPath?: string; destinationId?: string; sourceContextCache?: SourceContextCache }
) {
  const cluster = await ctx.stores.gapClusters.getCluster(clusterId);
  if (!cluster || cluster.status !== "active") {
    return { ok: false as const, code: "cluster_not_found" };
  }
  const memberships = await ctx.stores.gapClusters.listMembershipsForCluster(clusterId);
  const { summaries } = await ctx.stores.questionLogs.gapDetailsForIds(memberships.map((m) => m.gapId));
  // Give the drafter this flow's in-flight proposals / open PRs (from the
  // snapshot) so it can build on or avoid duplicating them. Exclude this
  // cluster's own proposal so a draft never sees its own PR.
  const openPullRequests = await collectOpenPullRequestContext(ctx, cluster.flowId, {
    excludeClusterId: clusterId
  });
  const outcome = await draftFromGaps(ctx, summaries, {
    flowId: cluster.flowId,
    targetPath: overrides.targetPath,
    destinationId: overrides.destinationId,
    sourceContextCache: overrides.sourceContextCache,
    openPullRequests,
    gapClusterId: clusterId
  });
  if (!outcome.ok) {
    return outcome;
  }
  // Drafting is enqueue-only: the proposal is created later by the job-completion
  // path, which links it back to its cluster. Nothing to link synchronously here.
  return outcome;
}
