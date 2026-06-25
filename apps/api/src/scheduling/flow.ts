import type { Proposal } from "@magpie/core";
import type { AppContext } from "../context.js";

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
