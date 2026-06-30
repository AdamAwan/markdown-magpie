import type { Proposal } from "@magpie/core";
import type { AppContext } from "../context.js";
import { openPullRequestSummaries } from "./reconcile-gate.js";

// File-local: knip runs strict, and sameFlow is used only within this module.
// Two flow ids are "the same flow" when they are equal, treating undefined (the
// un-routed/default flow) as a single bucket.
function sameFlow(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

// A proposal's owning flow. A first-class flowId (set by the patrol lenses) wins;
// otherwise it is the proposal's cluster's flow; a proposal with neither belongs to
// the un-routed/default flow.
export async function proposalFlowId(ctx: AppContext, proposal: Proposal): Promise<string | undefined> {
  if (proposal.flowId) {
    return proposal.flowId;
  }
  if (!proposal.gapClusterId) {
    return undefined;
  }
  const cluster = await ctx.stores.gapClusters.getCluster(proposal.gapClusterId);
  return cluster?.flowId;
}

// The open proposals in one flow — the gate's candidate set. Lists up to 200 open
// proposals (merged excluded by the store's default filter) and keeps those whose
// owning flow matches, optionally excluding one proposal by id (e.g. the rival
// itself in the at-draft fold path).
export async function sameFlowOpenProposals(
  ctx: AppContext,
  flowId: string | undefined,
  excludeId?: string
): Promise<Proposal[]> {
  const out: Proposal[] = [];
  for (const proposal of await ctx.stores.proposals.list(200)) {
    if (excludeId && proposal.id === excludeId) {
      continue;
    }
    if (!sameFlow(await proposalFlowId(ctx, proposal), flowId)) {
      continue;
    }
    out.push(proposal);
  }
  return out;
}

// The set of document paths already covered by an open proposal in this flow.
//
// A patrol lens (verify / dedupe / split / improve) must not re-propose a path an
// open same-flow PR already touches. The lens reads document content from the
// indexed branch, which still lacks the unmerged PR's edits, so it keeps proposing
// the same change every tick. Each fresh proposal then folds into the open PR —
// spamming "(automated fold-on-overlap)" comments and re-publishing the PR
// endlessly (a touchable overlap folds; a locked one defers into a rival PR — both
// are churn). Unlike the gap lens, which freezes the covered cluster, the
// clusterless patrol lenses have no such suppression, so we apply it here.
//
// Covers every open proposal regardless of touchability — a covered path should be
// left alone until its PR merges (and the edits reach the index) either way.
export async function flowCoveredPaths(ctx: AppContext, flowId: string | undefined): Promise<Set<string>> {
  const covered = new Set<string>();
  for (const summary of openPullRequestSummaries(await sameFlowOpenProposals(ctx, flowId))) {
    for (const path of summary.targets) {
      covered.add(path);
    }
  }
  return covered;
}
