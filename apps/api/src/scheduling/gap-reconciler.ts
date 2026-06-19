import type { Proposal } from "@magpie/core";
import { fetchPullRequestStatus as defaultFetchPullRequestStatus } from "@magpie/git";
import { GAP_RECONCILE_CRITIC, GAP_RECONCILE_PROPOSE } from "@magpie/prompts";
import type { AppContext } from "../context.js";
import * as gapsService from "../features/gaps/service.js";
import * as proposalsService from "../features/proposals/service.js";
import type { GapClusterRecord } from "../stores/gap-cluster-store.js";
import { selectRetainingChildOnSplit, selectSurvivingClusterOnMerge } from "./gap-reconciler-lineage.js";

export interface ReconcilerDeps {
  // Injected so unit tests stay offline. Defaults to the real GitHub lookup.
  fetchPullRequestStatus: typeof defaultFetchPullRequestStatus;
  // Publication side effects, injected so unit tests can observe them without
  // touching Git or GitHub. Default to the real implementations.
  publishProposal?: (ctx: AppContext, proposal: Proposal) => Promise<void>;
  supersedeProposal?: (ctx: AppContext, proposal: Proposal) => Promise<void>;
}

const DEFAULT_DEPS: ReconcilerDeps = {
  fetchPullRequestStatus: defaultFetchPullRequestStatus
};

interface ProposedMerge {
  clusterIds: string[];
  rationale: string;
}
interface ProposedSplit {
  clusterId: string;
  children: Array<{ gapIds: string[] }>;
  rationale: string;
}
interface ReshapeProposal {
  merges: ProposedMerge[];
  splits: ProposedSplit[];
}

// The single reconciliation job. Always runs the PR-state pass and drains the
// publication outbox; only does model clustering work when the gap catalog
// revision has advanced past what was last processed.
export async function reconcileGaps(ctx: AppContext, deps: ReconcilerDeps = DEFAULT_DEPS): Promise<void> {
  // (b) PR-state pass — folds in the former pull-request-refresh task.
  await refreshOpenPullRequests(ctx, deps);

  const catalogRevision = await ctx.stores.questionLogs.getGapCatalogRevision();
  const processed = await ctx.stores.gapClusters.getProcessedRevision();
  const pending = await ctx.stores.gapClusters.listPendingPublicationActions();

  // (a) Revision gate.
  if (catalogRevision === processed && pending.length === 0) {
    console.log(
      `Gap reconciler: no gap changes (catalog revision ${catalogRevision}) and no pending publication ` +
        "actions; ran the PR-state pass only."
    );
    return;
  }

  if (catalogRevision !== processed) {
    console.log(`Gap reconciler: gap catalog advanced ${processed} -> ${catalogRevision}; reconciling clusters.`);
    await reconcileClusters(ctx);
    await ctx.stores.gapClusters.setProcessedRevision(catalogRevision, new Date().toISOString());
  } else {
    console.log(`Gap reconciler: catalog revision unchanged (${catalogRevision}); draining ${pending.length} pending action(s).`);
  }

  // (d) Outbox: retry pending/failed publication actions without re-running models.
  await drainPublicationOutbox(ctx, deps);
}

async function refreshOpenPullRequests(ctx: AppContext, deps: ReconcilerDeps): Promise<void> {
  const open = await ctx.stores.proposals.list(200, { status: "pr-opened" });
  for (const proposal of open) {
    const pullRequestUrl = proposal.publication?.pullRequestUrl;
    if (!pullRequestUrl) {
      continue;
    }
    let status;
    try {
      status = await deps.fetchPullRequestStatus(pullRequestUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "pull request lookup failed";
      console.warn(`PR status check failed for proposal ${proposal.id}: ${message}`);
      continue;
    }
    if (!status) {
      continue;
    }
    if (status.merged) {
      const merged = await ctx.stores.proposals.updateStatus(proposal.id, "merged");
      if (merged) {
        console.log(`Gap reconciler: proposal ${proposal.id} merged; running cascade and freezing its cluster.`);
        await proposalsService.runMergeCascade(ctx, merged);
        await freezeClusterForProposal(ctx, merged);
      }
    } else if (status.state === "closed") {
      const rejected = await ctx.stores.proposals.updateStatus(proposal.id, "rejected");
      if (rejected) {
        console.log(`Gap reconciler: proposal ${proposal.id} PR closed without merge; marked rejected and froze its cluster.`);
        await freezeClusterForProposal(ctx, rejected);
      }
    }
  }
}

async function freezeClusterForProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.gapClusterId) {
    await ctx.stores.gapClusters.freezeCluster(proposal.gapClusterId);
  }
}

// (c) Clustering: assign new gaps, then propose merges/splits over the full
// active set and apply only the critic-confirmed changes.
async function reconcileClusters(ctx: AppContext): Promise<void> {
  // 1) Assign unassigned gaps to their own new cluster (per flow).
  const candidates = await ctx.stores.questionLogs.listGapCandidates(200);
  const activeMemberships = await ctx.stores.gapClusters.listActiveMemberships();
  const assignedGapIds = new Set(activeMemberships.map((m) => m.gapId));

  let clustersCreated = 0;
  for (const candidate of candidates) {
    const gapIds = await ctx.stores.questionLogs.gapIdsForSummary(candidate.summary, candidate.flowId);
    const unassigned = gapIds.filter((id) => !assignedGapIds.has(id));
    if (unassigned.length === 0) {
      continue;
    }
    const revision = await ctx.stores.questionLogs.getGapCatalogRevision();
    const cluster = await ctx.stores.gapClusters.createCluster({
      flowId: candidate.flowId,
      title: candidate.summary.slice(0, 80),
      revision
    });
    clustersCreated += 1;
    for (const gapId of unassigned) {
      await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId, "initial assignment");
      assignedGapIds.add(gapId);
    }
  }
  console.log(`Gap reconciler: created ${clustersCreated} new cluster(s) from unassigned gaps.`);

  // 2) Propose merges/splits over the full active set. A single cluster has
  // nothing to merge; splits stay out of the first cut, so this is gated rather
  // than returning early — drafting below must run for the single-cluster case too.
  const active = await ctx.stores.gapClusters.listActiveClusters();
  if (active.length >= 2) {
    const proposal = await proposeReshape(ctx, active);

    // 3) Critic-confirm and apply each change individually.
    for (const merge of proposal.merges) {
      if (merge.clusterIds.length < 2) {
        continue;
      }
      const confirmed = await criticConfirm(ctx, "merge", merge.rationale);
      if (!confirmed) {
        console.log(`Gap reconciler: critic rejected a proposed merge of ${merge.clusterIds.length} clusters.`);
        continue;
      }
      console.log(`Gap reconciler: critic confirmed a merge of clusters ${merge.clusterIds.join(", ")}.`);
      await applyMerge(ctx, merge);
    }
    for (const split of proposal.splits) {
      if (split.children.length < 2) {
        continue;
      }
      const confirmed = await criticConfirm(ctx, "split", split.rationale);
      if (!confirmed) {
        console.log(`Gap reconciler: critic rejected a proposed split of cluster ${split.clusterId}.`);
        continue;
      }
      console.log(`Gap reconciler: critic confirmed a split of cluster ${split.clusterId} into ${split.children.length}.`);
      await applySplit(ctx, split);
    }
  }

  // 4) Draft a proposal for every active cluster that has none yet, so a fresh
  // cluster becomes a pull request autonomously instead of waiting for a manual
  // trigger. This is the autonomous gap->PR step the on-demand pipeline used to do.
  await draftProposalsForUncoveredClusters(ctx);
}

// Drafts a proposal for each active cluster with no linked proposal. draftFromCluster
// links the proposal and enqueues its publish action, which drainPublicationOutbox
// processes in the same run. Frozen clusters (merged/rejected PRs) are excluded by
// listActiveClusters, so content a reviewer already declined is never re-raised.
async function draftProposalsForUncoveredClusters(ctx: AppContext): Promise<void> {
  const active = await ctx.stores.gapClusters.listActiveClusters();
  const proposals = await ctx.stores.proposals.list(500);
  const coveredClusterIds = new Set(
    proposals.map((p) => p.gapClusterId).filter((id): id is string => Boolean(id))
  );

  // Collect each source set's context once for the whole run; clusters sharing a
  // flow (and so the same sources) reuse the bytes instead of re-walking the
  // checkout per draft.
  const sourceContextCache: proposalsService.SourceContextCache = new Map();

  let drafted = 0;
  for (const cluster of active) {
    if (coveredClusterIds.has(cluster.id)) {
      continue;
    }
    try {
      const outcome = await gapsService.draftFromCluster(ctx, cluster.id, { sourceContextCache });
      if (outcome.ok) {
        drafted += 1;
        console.log(
          `Gap reconciler: drafted a proposal for cluster ${cluster.id} ("${cluster.title}") in ${outcome.mode} mode.`
        );
      } else {
        console.warn(`Gap reconciler: could not draft a proposal for cluster ${cluster.id}: ${outcome.code}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "draft failed";
      console.warn(`Gap reconciler: failed to draft a proposal for cluster ${cluster.id}: ${message}`);
    }
  }
  console.log(`Gap reconciler: drafted ${drafted} new proposal(s) for previously uncovered clusters.`);
}

async function proposeReshape(ctx: AppContext, active: GapClusterRecord[]): Promise<ReshapeProposal> {
  const summary = active.map((c) => `cluster ${c.id} (flow ${c.flowId ?? "none"}): ${c.title}`).join("\n");
  const response = await ctx.providers.chat(ctx.config.get().aiProvider).complete({
    system: GAP_RECONCILE_PROPOSE.instructions,
    messages: [{ role: "user", content: summary }]
  });
  return parseReshape(response.content);
}

async function criticConfirm(ctx: AppContext, kind: "merge" | "split", rationale: string): Promise<boolean> {
  const response = await ctx.providers.chat(ctx.config.get().aiProvider).complete({
    system: GAP_RECONCILE_CRITIC.instructions,
    messages: [{ role: "user", content: `Proposed ${kind}. Rationale: ${rationale}` }]
  });
  try {
    const parsed = JSON.parse(response.content) as { confirmed?: boolean };
    return parsed.confirmed === true;
  } catch {
    return false; // unparseable critic = not confirmed
  }
}

function parseReshape(content: string): ReshapeProposal {
  try {
    const parsed = JSON.parse(content) as Partial<ReshapeProposal>;
    return { merges: parsed.merges ?? [], splits: parsed.splits ?? [] };
  } catch {
    return { merges: [], splits: [] };
  }
}

async function applyMerge(ctx: AppContext, merge: ProposedMerge): Promise<void> {
  const fetched = await Promise.all(merge.clusterIds.map((id) => ctx.stores.gapClusters.getCluster(id)));
  const clusters = fetched.filter((c): c is GapClusterRecord => Boolean(c) && c?.status === "active");
  if (clusters.length < 2) {
    return;
  }
  const survivorId = selectSurvivingClusterOnMerge(clusters.map((c) => ({ id: c.id, createdAt: c.createdAt })));
  const revision = await ctx.stores.questionLogs.getGapCatalogRevision();
  for (const cluster of clusters) {
    if (cluster.id === survivorId) {
      continue;
    }
    const members = await ctx.stores.gapClusters.listMembershipsForCluster(cluster.id);
    for (const member of members) {
      await ctx.stores.gapClusters.assignGapToCluster(survivorId, member.gapId, "merged");
    }
    await ctx.stores.gapClusters.freezeCluster(cluster.id);
    // Supersede the merged-away cluster's open proposal, if any.
    const proposal = await proposalForCluster(ctx, cluster.id);
    if (proposal && isOpenProposal(proposal)) {
      await ctx.stores.proposals.updateStatus(proposal.id, "superseded");
      await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "supersede");
    }
  }
  await ctx.stores.gapClusters.updateCluster(survivorId, { revision });
  const survivorProposal = await proposalForCluster(ctx, survivorId);
  if (survivorProposal) {
    await ctx.stores.gapClusters.enqueuePublicationAction(survivorProposal.id, "publish");
  }
}

async function applySplit(ctx: AppContext, split: ProposedSplit): Promise<void> {
  const original = await ctx.stores.gapClusters.getCluster(split.clusterId);
  if (!original || original.status !== "active") {
    return;
  }
  const revision = await ctx.stores.questionLogs.getGapCatalogRevision();
  const children = split.children.map((child, index) => ({ key: `child-${index}`, gapIds: child.gapIds }));
  const retainingKey = selectRetainingChildOnSplit(children);

  for (const child of children) {
    if (child.key === retainingKey) {
      // The largest child keeps the original cluster. assignGapToCluster moves any
      // non-retained gap out when a new child claims it below, so nothing to do here.
      continue;
    }
    const newCluster = await ctx.stores.gapClusters.createCluster({
      flowId: original.flowId,
      title: original.title,
      parentClusterId: original.id,
      revision
    });
    for (const gapId of child.gapIds) {
      await ctx.stores.gapClusters.assignGapToCluster(newCluster.id, gapId, "split");
    }
  }
  await ctx.stores.gapClusters.updateCluster(original.id, { revision });
  const retainedProposal = await proposalForCluster(ctx, original.id);
  if (retainedProposal) {
    await ctx.stores.gapClusters.enqueuePublicationAction(retainedProposal.id, "publish");
  }
}

function isOpenProposal(proposal: Proposal): boolean {
  return (
    proposal.status === "draft" ||
    proposal.status === "ready" ||
    proposal.status === "branch-pushed" ||
    proposal.status === "pr-opened"
  );
}

async function proposalForCluster(ctx: AppContext, clusterId: string): Promise<Proposal | undefined> {
  const all = await ctx.stores.proposals.list(500);
  return all.find((p) => p.gapClusterId === clusterId);
}

async function drainPublicationOutbox(ctx: AppContext, deps: ReconcilerDeps): Promise<void> {
  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  if (actions.length === 0) {
    return;
  }
  console.log(`Gap reconciler: draining ${actions.length} pending publication action(s).`);
  let done = 0;
  let failed = 0;
  for (const action of actions) {
    const proposal = await ctx.stores.proposals.get(action.proposalId);
    if (!proposal) {
      await ctx.stores.gapClusters.markPublicationActionDone(action.id);
      done += 1;
      continue;
    }
    try {
      if (action.kind === "publish") {
        await (deps.publishProposal ?? defaultPublish)(ctx, proposal);
      } else {
        await (deps.supersedeProposal ?? defaultSupersede)(ctx, proposal);
      }
      await ctx.stores.gapClusters.markPublicationActionDone(action.id);
      done += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "publication failed";
      await ctx.stores.gapClusters.markPublicationActionFailed(action.id, message);
      failed += 1;
      console.warn(`Publication action ${action.id} (${action.kind}) for proposal ${action.proposalId} failed: ${message}`);
    }
  }
  console.log(`Gap reconciler: publication outbox drained — ${done} done, ${failed} failed.`);
}

async function defaultPublish(ctx: AppContext, proposal: Proposal): Promise<void> {
  // Re-fetch live PR state immediately before mutating (spec: defend against a
  // state change between reconciliation and publication).
  const result = await proposalsService.publishReadyProposal(ctx, proposal);
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.message}`);
  }
}

async function defaultSupersede(_ctx: AppContext, _proposal: Proposal): Promise<void> {
  // Closing the PR on GitHub is host-specific; implemented when closePullRequest
  // lands in @magpie/git. Until then, the DB status is already 'superseded' and
  // this is a no-op that completes the action.
}
