import type {
  FlowSnapshot,
  FlowSnapshotView,
  Proposal,
  ReviewDecision,
  SnapshotProposal,
  SnapshotPullRequest
} from "@magpie/core";
import type { AppContext } from "../../context.js";
import { logger } from "../../logger.js";

// A pull request's externally-observed state, as reported by the
// refresh_flow_snapshot watcher job. The API holds no GitHub token, so it never
// polls the host itself — PR state only ever reaches a snapshot through this.
export type PullRequestReading = { merged: boolean; state: "open" | "closed"; reviewDecision?: ReviewDecision };

function sameFlow(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

const DEFAULT_FLOW_LABEL = "Default flow";

function flowName(ctx: AppContext, flowId: string | undefined): string {
  if (!flowId) {
    return DEFAULT_FLOW_LABEL;
  }
  return ctx.knowledgeConfig.flows.find((flow) => flow.id === flowId)?.name ?? flowId;
}

// Reads the on-disk snapshot for every known flow — the configured flows plus the
// un-routed/default flow — returning only those a fetch job has actually written.
// A pure read of the downloaded-data location; it never polls the host.
export async function listFlowSnapshots(ctx: AppContext): Promise<FlowSnapshotView[]> {
  const flowIds: Array<string | undefined> = [undefined, ...ctx.knowledgeConfig.flows.map((flow) => flow.id)];
  const views: FlowSnapshotView[] = [];
  for (const flowId of flowIds) {
    const snapshot = await ctx.stores.snapshots.read(flowId);
    if (snapshot) {
      views.push({ ...snapshot, flowName: flowName(ctx, flowId) });
    }
  }
  return views;
}

// Reads one flow's snapshot, or undefined when no fetch job has written it yet.
export async function readFlowSnapshot(
  ctx: AppContext,
  flowId: string | undefined
): Promise<FlowSnapshotView | undefined> {
  const snapshot = await ctx.stores.snapshots.read(flowId);
  return snapshot ? { ...snapshot, flowName: flowName(ctx, flowId) } : undefined;
}

// A proposal's flow is its cluster's flow; a cluster-less proposal belongs to the
// un-routed/default flow. Cached per run to avoid repeat cluster reads.
type ClusterFlowCache = Map<string, string | undefined>;

async function proposalFlowId(
  ctx: AppContext,
  proposal: Proposal,
  cache: ClusterFlowCache
): Promise<string | undefined> {
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

// Writes one flow's gaps, in-flight proposals, and open-PR state to the snapshot
// store — the inputs the reconciler would otherwise gather live. Gaps and
// proposals are read locally; PR state comes from `pullRequestStatuses`, keyed by
// proposal id, which the refresh_flow_snapshot watcher job polled (the API holds
// no GitHub token). A pr-opened proposal the watcher didn't report this run keeps
// its last known reading rather than regressing to "unknown".
export async function refreshSnapshot(
  ctx: AppContext,
  flowId: string | undefined,
  pullRequestStatuses: ReadonlyMap<string, PullRequestReading>
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

  // Carry forward the previous reading for any open PR the watcher didn't report
  // this run, so it keeps its last known state rather than regressing to "unknown".
  const previous = await ctx.stores.snapshots.read(flowId);
  const previousByProposal = new Map((previous?.pullRequests ?? []).map((pr) => [pr.proposalId, pr]));

  const pullRequests: SnapshotPullRequest[] = [];
  let carried = 0;
  for (const proposal of flowProposals) {
    if (proposal.status !== "pr-opened") {
      continue;
    }
    const url = proposal.publication?.pullRequestUrl;
    if (!url) {
      continue;
    }
    const reported = pullRequestStatuses.get(proposal.id);
    if (reported) {
      pullRequests.push({
        proposalId: proposal.id,
        url,
        merged: reported.merged,
        state: reported.state,
        ...(reported.reviewDecision ? { reviewDecision: reported.reviewDecision } : {}),
        checkedAt: takenAt
      });
      continue;
    }
    const prior = previousByProposal.get(proposal.id);
    carried += 1;
    pullRequests.push(
      prior
        ? { ...prior, checkedAt: takenAt }
        : { proposalId: proposal.id, url, merged: false, state: "unknown", checkedAt: takenAt }
    );
  }

  const snapshot: FlowSnapshot = { flowId, takenAt, catalogRevision, gaps, proposals, pullRequests };
  await ctx.stores.snapshots.write(snapshot);
  logger.info(
    { flowLabel, gaps: gaps.length, proposals: proposals.length, openPrs: pullRequests.length, carried },
    "snapshot refresh completed"
  );
  return snapshot;
}

// Writes every flow's snapshot from the PR states the refresh_flow_snapshot watcher
// job just reported. That job lists every open PR across flows in one run, so a
// single completion refreshes all flows' snapshots. This is the snapshot store's
// only production writer; without it the /snapshots page and the reconciler's PR
// cache stay empty.
export async function recordSnapshotsFromPullRequestResults(
  ctx: AppContext,
  results: ReadonlyArray<{ proposalId: string } & PullRequestReading>
): Promise<void> {
  const statuses = new Map<string, PullRequestReading>(
    results.map((result) => [
      result.proposalId,
      {
        merged: result.merged,
        state: result.state,
        ...(result.reviewDecision ? { reviewDecision: result.reviewDecision } : {})
      }
    ])
  );
  const flowIds: Array<string | undefined> = [undefined, ...ctx.knowledgeConfig.flows.map((flow) => flow.id)];
  for (const flowId of flowIds) {
    await refreshSnapshot(ctx, flowId, statuses);
  }
}
