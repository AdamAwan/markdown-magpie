import type { Proposal } from "@magpie/core";
import { fetchPullRequestStatus as defaultFetchPullRequestStatus } from "@magpie/git";
import type { AppContext } from "../../context.js";
import type { FlowSnapshot, SnapshotProposal, SnapshotPullRequest } from "../../stores/snapshot-store.js";

export interface SnapshotDeps {
  // Injected so tests can run offline. Defaults to the real GitHub lookup.
  fetchPullRequestStatus: typeof defaultFetchPullRequestStatus;
}

const DEFAULT_DEPS: SnapshotDeps = {
  fetchPullRequestStatus: defaultFetchPullRequestStatus
};

function sameFlow(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

// A proposal's flow is its cluster's flow; a cluster-less proposal belongs to the
// un-routed/default flow. Cached per run to avoid repeat cluster reads.
type ClusterFlowCache = Map<string, string | undefined>;

async function proposalFlowId(ctx: AppContext, proposal: Proposal, cache: ClusterFlowCache): Promise<string | undefined> {
  const clusterId = proposal.gapClusterId;
  if (!clusterId) {
    return undefined;
  }
  if (cache.has(clusterId)) {
    return cache.get(clusterId);
  }
  const cluster = await ctx.stores.gapClusters.getCluster(clusterId);
  cache.set(clusterId, cluster?.flowId);
  return cluster?.flowId;
}

// Downloads one flow's gaps, in-flight proposals, and open-PR state to the
// snapshot store. This is the "fetch" half of the fetch/process split: it is the
// only place that polls GitHub, on its own schedule, so the reconciler can read
// PR state from the snapshot instead of calling the host during reconciliation.
export async function refreshSnapshot(
  ctx: AppContext,
  flowId: string | undefined,
  deps: SnapshotDeps = DEFAULT_DEPS
): Promise<FlowSnapshot> {
  const flowLabel = flowId ?? "default";
  const cache: ClusterFlowCache = new Map();
  const takenAt = new Date().toISOString();
  const catalogRevision = await ctx.stores.questionLogs.getGapCatalogRevision(flowId);

  const gaps = (await ctx.stores.questionLogs.listGapCandidates(500)).filter((gap) => sameFlow(gap.flowId, flowId));

  // This flow's in-flight proposals (drafts through pr-opened).
  const allProposals = await ctx.stores.proposals.list(1000);
  const flowProposals: Proposal[] = [];
  for (const proposal of allProposals) {
    if (sameFlow(await proposalFlowId(ctx, proposal, cache), flowId)) {
      flowProposals.push(proposal);
    }
  }
  const proposals: SnapshotProposal[] = flowProposals.map((proposal) => ({
    id: proposal.id,
    title: proposal.title,
    status: proposal.status,
    gapClusterId: proposal.gapClusterId,
    pullRequestUrl: proposal.publication?.pullRequestUrl
  }));

  // Carry forward the previous poll so a PR we can't reach this run keeps its last
  // known state rather than regressing to "unknown".
  const previous = await ctx.stores.snapshots.read(flowId);
  const previousByProposal = new Map((previous?.pullRequests ?? []).map((pr) => [pr.proposalId, pr]));

  const pullRequests: SnapshotPullRequest[] = [];
  for (const proposal of flowProposals) {
    if (proposal.status !== "pr-opened") {
      continue;
    }
    const url = proposal.publication?.pullRequestUrl;
    if (!url) {
      continue;
    }
    try {
      const status = await deps.fetchPullRequestStatus(url);
      if (!status) {
        // Not a resolvable GitHub PR (or no token); keep any prior reading.
        const prior = previousByProposal.get(proposal.id);
        pullRequests.push(prior ?? { proposalId: proposal.id, url, merged: false, state: "unknown", checkedAt: takenAt });
        continue;
      }
      pullRequests.push({ proposalId: proposal.id, url, merged: status.merged, state: status.state, checkedAt: takenAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : "pull request lookup failed";
      console.warn(`Snapshot refresh [${flowLabel}]: PR status check failed for proposal ${proposal.id}: ${message}`);
      const prior = previousByProposal.get(proposal.id);
      pullRequests.push(prior ?? { proposalId: proposal.id, url, merged: false, state: "unknown", checkedAt: takenAt });
    }
  }

  const snapshot: FlowSnapshot = { flowId, takenAt, catalogRevision, gaps, proposals, pullRequests };
  await ctx.stores.snapshots.write(snapshot);
  console.log(
    `Snapshot refresh [${flowLabel}]: ${gaps.length} gap(s), ${proposals.length} proposal(s), ${pullRequests.length} open PR(s).`
  );
  return snapshot;
}
