import type { GapCandidate, SuggestedGapCluster } from "@magpie/core";
import { GAP_CLUSTERING } from "@magpie/prompts";
import type { AppContext } from "../../context.js";
import { assembleClusters, singletonCluster } from "../../stores/gap-clustering.js";
import { parseJsonObject } from "../../platform/json.js";

export async function listCandidates(ctx: AppContext, limit: number): Promise<GapCandidate[]> {
  return ctx.stores.questionLogs.listGapCandidates(limit);
}

export async function listClusters(ctx: AppContext, limit: number): Promise<SuggestedGapCluster[]> {
  const candidates = await ctx.stores.questionLogs.listGapCandidates(limit);
  return clusterGapCandidates(ctx, candidates);
}

export async function clusterGapCandidates(
  ctx: AppContext,
  candidates: GapCandidate[]
): Promise<SuggestedGapCluster[]> {
  const canCluster =
    ctx.config.get().aiProvider === "openai-compatible" || ctx.config.get().aiProvider === "azure-openai";
  if (!canCluster || candidates.length <= 1) {
    return candidates.map((candidate) => singletonCluster(candidate));
  }

  // Cluster within each flow only: gaps belonging to different flows answer to
  // different audiences and destinations, so they must never share a cluster (or
  // proposal). Each flow's candidates are grouped independently and concatenated.
  const clusters: SuggestedGapCluster[] = [];
  for (const [flowId, group] of groupByFlow(candidates)) {
    if (group.length <= 1) {
      clusters.push(...group.map((candidate) => singletonCluster(candidate)));
      continue;
    }
    try {
      clusters.push(...(await requestGapClusters(ctx, group, flowId)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "clustering failed";
      console.warn(`Gap clustering failed for flow ${flowId || "(none)"} (${message}); one cluster per gap.`);
      clusters.push(...group.map((candidate) => singletonCluster(candidate)));
    }
  }
  return clusters;
}

// Buckets candidates by flow, preserving the order in which each flow first
// appears so the resulting cluster list stays stable across refreshes. The key
// is "" for un-routed candidates; the flowId passed downstream is undefined then.
function groupByFlow(candidates: GapCandidate[]): Map<string, GapCandidate[]> {
  const groups = new Map<string, GapCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.flowId ?? "";
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return groups;
}

export async function requestGapClusters(
  ctx: AppContext,
  candidates: GapCandidate[],
  flowId?: string
): Promise<SuggestedGapCluster[]> {
  const response = await ctx.providers.chat(ctx.config.get().aiProvider).complete({
    system: GAP_CLUSTERING.instructions,
    messages: [
      {
        role: "user",
        content: JSON.stringify({ gaps: candidates.map((candidate) => candidate.summary) }, null, 2)
      }
    ]
  });

  return assembleClusters(candidates, parseJsonObject(response.content), flowId || undefined);
}
