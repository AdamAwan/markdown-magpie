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

  try {
    return await requestGapClusters(ctx, candidates);
  } catch (error) {
    const message = error instanceof Error ? error.message : "clustering failed";
    console.warn(`Gap clustering failed (${message}); falling back to one cluster per gap.`);
    return candidates.map((candidate) => singletonCluster(candidate));
  }
}

export async function requestGapClusters(
  ctx: AppContext,
  candidates: GapCandidate[]
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

  return assembleClusters(candidates, parseJsonObject(response.content));
}
