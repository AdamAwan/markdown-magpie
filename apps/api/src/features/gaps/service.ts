import type { GapCandidate, PersistedGapCluster } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { draftFromGaps, type SourceContextCache } from "../proposals/service.js";

export async function listCandidates(ctx: AppContext, limit: number): Promise<GapCandidate[]> {
  return ctx.stores.questionLogs.listGapCandidates(limit);
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

// Drafts one proposal from a persisted cluster, linking the proposal back to the
// cluster and queueing it for publication. The cluster's own flow routes the
// draft, so the caller only supplies optional target/destination overrides. Only
// the synchronous (direct-mode) proposal is linked here; in queue mode the
// proposal is created later by the AI-job completion path and links there.
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
  const outcome = await draftFromGaps(ctx, summaries, {
    flowId: cluster.flowId,
    targetPath: overrides.targetPath,
    destinationId: overrides.destinationId,
    sourceContextCache: overrides.sourceContextCache
  });
  if (!outcome.ok) {
    return outcome;
  }
  if (outcome.mode === "direct") {
    await ctx.stores.proposals.linkCluster(outcome.proposal.id, clusterId);
    await ctx.stores.gapClusters.enqueuePublicationAction(outcome.proposal.id, "publish");
  }
  return outcome;
}
