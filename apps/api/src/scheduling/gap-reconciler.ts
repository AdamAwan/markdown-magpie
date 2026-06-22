import type { Proposal } from "@magpie/core";
import { fetchPullRequestStatus as defaultFetchPullRequestStatus } from "@magpie/git";
import { reconcileGapClustersOutputSchema } from "@magpie/jobs";
import type { AppContext } from "../context.js";
import * as gapsService from "../features/gaps/service.js";
import { runJobToCompletion } from "../features/jobs/service.js";
import * as proposalsService from "../features/proposals/service.js";
import type { GapClusterRecord, PublicationActionRecord } from "../stores/gap-cluster-store.js";
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

// Resolved cluster->flow lookups, reused across a single run so each cluster's
// flow is read at most once.
type ClusterFlowCache = Map<string, string | undefined>;

function sameFlow(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

// The single reconciliation job, scoped to one flow (`undefined` is the
// un-routed/default flow). Each flow runs on its own schedule and run-lock, so a
// gap change, slow run, or stuck PR in one flow never blocks another. Always runs
// the PR-state pass and drains the publication outbox for this flow; only does
// model clustering work when the flow's gap-catalog revision has advanced past
// what was last processed for it.
export async function reconcileGaps(
  ctx: AppContext,
  flowId: string | undefined,
  deps: ReconcilerDeps = DEFAULT_DEPS
): Promise<void> {
  const flowLabel = flowId ?? "default";
  const clusterFlowCache: ClusterFlowCache = new Map();

  // (b) PR-state pass — only the open pull requests raised from this flow's proposals.
  await refreshOpenPullRequests(ctx, flowId, deps, clusterFlowCache);

  const catalogRevision = await ctx.stores.questionLogs.getGapCatalogRevision(flowId);
  const processed = await ctx.stores.gapClusters.getProcessedRevision(flowId);
  const pending = await flowPendingActions(ctx, flowId, clusterFlowCache);

  // (a) Revision gate.
  if (catalogRevision === processed && pending.length === 0) {
    console.log(
      `Gap reconciler [${flowLabel}]: no gap changes (catalog revision ${catalogRevision}) and no pending ` +
        "publication actions; ran the PR-state pass only."
    );
    return;
  }

  if (catalogRevision !== processed) {
    console.log(
      `Gap reconciler [${flowLabel}]: gap catalog advanced ${processed} -> ${catalogRevision}; reconciling clusters.`
    );
    await reconcileClusters(ctx, flowId);
    await ctx.stores.gapClusters.setProcessedRevision(flowId, catalogRevision, new Date().toISOString());
  } else {
    console.log(
      `Gap reconciler [${flowLabel}]: catalog revision unchanged (${catalogRevision}); draining ${pending.length} pending action(s).`
    );
  }

  // (d) Outbox: retry this flow's pending/failed publication actions without re-running models.
  await drainPublicationOutbox(ctx, flowId, deps, clusterFlowCache);
}

async function refreshOpenPullRequests(
  ctx: AppContext,
  flowId: string | undefined,
  deps: ReconcilerDeps,
  cache: ClusterFlowCache
): Promise<void> {
  // Prefer the PR state the fetch job already downloaded for this flow; only poll
  // the host live for a PR the snapshot hasn't covered yet (e.g. one opened since
  // the last fetch, or before the fetch job has ever run). This keeps the
  // reconciler off the network in the steady state. defaultPublish still re-checks
  // live state immediately before mutating, so acting on a snapshot reading can't
  // publish against a PR that changed since the fetch.
  const snapshot = await ctx.stores.snapshots.read(flowId);
  const snapshotByProposal = new Map((snapshot?.pullRequests ?? []).map((pr) => [pr.proposalId, pr]));

  const open = await ctx.stores.proposals.list(200, { status: "pr-opened" });
  for (const proposal of open) {
    // Only consider PRs that came from this flow's proposals — never any other
    // flow's, and never an arbitrary PR on the repo.
    if (!sameFlow(await proposalFlowId(ctx, proposal, cache), flowId)) {
      continue;
    }
    const pullRequestUrl = proposal.publication?.pullRequestUrl;
    if (!pullRequestUrl) {
      continue;
    }
    let status: { merged: boolean; state: "open" | "closed" } | undefined;
    const cached = snapshotByProposal.get(proposal.id);
    if (cached && cached.state !== "unknown") {
      status = { merged: cached.merged, state: cached.state };
    } else {
      try {
        status = await deps.fetchPullRequestStatus(pullRequestUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : "pull request lookup failed";
        console.warn(`PR status check failed for proposal ${proposal.id}: ${message}`);
        continue;
      }
    }
    if (!status) {
      continue;
    }
    await applyPullRequestTransition(ctx, proposal.id, status);
  }
}

// The merged/closed proposal transition, applied by BOTH this reconciler's PR-state
// pass and the refresh_pull_requests completion handler. Kept here and shared so the
// two paths can never drift: merged ⇒ updateStatus("merged") + runMergeCascade +
// freeze the cluster; a close-without-merge ⇒ updateStatus("rejected") + freeze.
// Idempotent by guarding on the proposal's CURRENT status: only a still-open
// (pr-opened) proposal is transitioned, so re-applying the same reading — e.g.
// re-completing a refresh_pull_requests job — is a no-op and never runs the cascade
// twice. (updateStatus itself returns the proposal even when nothing changed, so the
// guard, not its return value, is what makes this safe.)
export async function applyPullRequestTransition(
  ctx: AppContext,
  proposalId: string,
  status: { merged: boolean; state: "open" | "closed" }
): Promise<void> {
  const current = await ctx.stores.proposals.get(proposalId);
  if (!current || current.status !== "pr-opened") {
    return;
  }
  if (status.merged) {
    const merged = await ctx.stores.proposals.updateStatus(proposalId, "merged");
    if (merged) {
      console.log(`Gap reconciler: proposal ${proposalId} merged; running cascade and freezing its cluster.`);
      await proposalsService.runMergeCascade(ctx, merged);
      await freezeClusterForProposal(ctx, merged);
    }
  } else if (status.state === "closed") {
    const rejected = await ctx.stores.proposals.updateStatus(proposalId, "rejected");
    if (rejected) {
      console.log(`Gap reconciler: proposal ${proposalId} PR closed without merge; marked rejected and froze its cluster.`);
      await freezeClusterForProposal(ctx, rejected);
    }
  }
}

async function freezeClusterForProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.gapClusterId) {
    await ctx.stores.gapClusters.freezeCluster(proposal.gapClusterId);
  }
}

// (c) Clustering for one flow: assign the flow's new gaps, then propose
// merges/splits over the flow's active set and apply only the critic-confirmed
// changes. Everything is filtered to `flowId` so a reshape can never mix flows.
async function reconcileClusters(ctx: AppContext, flowId: string | undefined): Promise<void> {
  const flowLabel = flowId ?? "default";

  // 1) Assign this flow's unassigned gaps to their own new cluster.
  const candidates = (await ctx.stores.questionLogs.listGapCandidates(200)).filter((c) => sameFlow(c.flowId, flowId));
  const activeMemberships = await ctx.stores.gapClusters.listActiveMemberships();
  const assignedGapIds = new Set(activeMemberships.map((m) => m.gapId));

  let clustersCreated = 0;
  for (const candidate of candidates) {
    const gapIds = await ctx.stores.questionLogs.gapIdsForSummary(candidate.summary, candidate.flowId);
    const unassigned = gapIds.filter((id) => !assignedGapIds.has(id));
    if (unassigned.length === 0) {
      continue;
    }
    const revision = await ctx.stores.questionLogs.getGapCatalogRevision(flowId);
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
  console.log(`Gap reconciler [${flowLabel}]: created ${clustersCreated} new cluster(s) from unassigned gaps.`);

  // 2) Reshape this flow's active clusters. The propose→critic generative step now
  // runs as a reconcile_gap_clusters AI job in the watcher; the API enqueues it and
  // bounded-waits for the critic-confirmed verdicts. A single cluster has nothing
  // to merge, so this is gated (not an early return) — drafting below must still
  // run for the single-cluster case. Reshape is best-effort: when no chat watcher
  // is available (timeout) or the job fails, we log and skip, leaving the rest of
  // reconcileGaps to run.
  const active = (await ctx.stores.gapClusters.listActiveClusters()).filter((c) => sameFlow(c.flowId, flowId));
  if (active.length >= 2) {
    const reshape = await requestReshape(ctx, active, flowId, flowLabel);
    if (reshape) {
      // 3) Apply only the critic-confirmed changes, recording every decision
      // (confirmed or not) so it's inspectable in the UI, not just in the logs.
      for (const merge of reshape.merges) {
        if (merge.clusterIds.length < 2) {
          continue;
        }
        await ctx.stores.reconciliations.record({
          flowId,
          kind: "merge",
          rationale: merge.rationale,
          confirmed: merge.confirmed,
          applied: merge.confirmed,
          clusterIds: merge.clusterIds
        });
        if (!merge.confirmed) {
          console.log(`Gap reconciler [${flowLabel}]: critic rejected a proposed merge of ${merge.clusterIds.length} clusters.`);
          continue;
        }
        console.log(`Gap reconciler [${flowLabel}]: critic confirmed a merge of clusters ${merge.clusterIds.join(", ")}.`);
        await applyMerge(ctx, { clusterIds: merge.clusterIds, rationale: merge.rationale }, flowId);
      }
      for (const split of reshape.splits) {
        if (split.children.length < 2) {
          continue;
        }
        await ctx.stores.reconciliations.record({
          flowId,
          kind: "split",
          rationale: split.rationale,
          confirmed: split.confirmed,
          applied: split.confirmed,
          clusterIds: [split.clusterId]
        });
        if (!split.confirmed) {
          console.log(`Gap reconciler [${flowLabel}]: critic rejected a proposed split of cluster ${split.clusterId}.`);
          continue;
        }
        console.log(`Gap reconciler [${flowLabel}]: critic confirmed a split of cluster ${split.clusterId} into ${split.children.length}.`);
        await applySplit(ctx, { clusterId: split.clusterId, children: split.children, rationale: split.rationale }, flowId);
      }
    }
  }

  // 4) Draft a proposal for every active cluster in this flow that has none yet,
  // so a fresh cluster becomes a pull request autonomously instead of waiting for
  // a manual trigger. This is the autonomous gap->PR step the on-demand pipeline
  // used to do.
  await draftProposalsForUncoveredClusters(ctx, flowId);
}

// Drafts a proposal for each active cluster in this flow with no linked proposal.
// draftFromCluster links the proposal and enqueues its publish action, which
// drainPublicationOutbox processes in the same run. Frozen clusters (merged/
// rejected PRs) are excluded by listActiveClusters, so content a reviewer already
// declined is never re-raised.
async function draftProposalsForUncoveredClusters(ctx: AppContext, flowId: string | undefined): Promise<void> {
  const active = (await ctx.stores.gapClusters.listActiveClusters()).filter((c) => sameFlow(c.flowId, flowId));
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
          `Gap reconciler [${flowId ?? "default"}]: enqueued a draft for cluster ${cluster.id} ("${cluster.title}") as job ${outcome.job.id}.`
        );
      } else {
        console.warn(`Gap reconciler [${flowId ?? "default"}]: could not draft a proposal for cluster ${cluster.id}: ${outcome.code}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "draft failed";
      console.warn(`Gap reconciler [${flowId ?? "default"}]: failed to draft a proposal for cluster ${cluster.id}: ${message}`);
    }
  }
  console.log(`Gap reconciler [${flowId ?? "default"}]: drafted ${drafted} new proposal(s) for previously uncovered clusters.`);
}

type Reshape = ReturnType<typeof reconcileGapClustersOutputSchema.parse>;

// Enqueues the reconcile_gap_clusters AI job for this flow's active clusters and
// bounded-waits for the watcher to propose→critic-confirm the reshape. Returns the
// validated verdicts, or `undefined` when the reshape could not be obtained
// (timeout with no chat watcher, job failure/cancellation, or malformed output) —
// the caller treats that as "skip reshape this run".
async function requestReshape(
  ctx: AppContext,
  active: GapClusterRecord[],
  flowId: string | undefined,
  flowLabel: string
): Promise<Reshape | undefined> {
  const input = {
    clusters: active.map((c) => ({ id: c.id, ...(c.flowId ? { flowId: c.flowId } : {}), title: c.title })),
    ...(flowId ? { flowId } : {}),
    provider: ctx.config.get().aiProvider
  };

  let terminal;
  try {
    terminal = await runJobToCompletion(ctx, "reconcile_gap_clusters", input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "reshape job failed";
    console.warn(`Gap reconciler [${flowLabel}]: reshape job could not be enqueued: ${message}; skipping reshape.`);
    return undefined;
  }

  if (terminal.state !== "completed") {
    console.warn(
      `Gap reconciler [${flowLabel}]: reshape job ${terminal.id} did not complete (state ${terminal.state}); ` +
        "skipping reshape this run."
    );
    return undefined;
  }

  const parsed = reconcileGapClustersOutputSchema.safeParse(terminal.output);
  if (!parsed.success) {
    console.warn(`Gap reconciler [${flowLabel}]: reshape job ${terminal.id} returned malformed output; skipping reshape.`);
    return undefined;
  }
  return parsed.data;
}

async function applyMerge(ctx: AppContext, merge: ProposedMerge, flowId: string | undefined): Promise<void> {
  const fetched = await Promise.all(merge.clusterIds.map((id) => ctx.stores.gapClusters.getCluster(id)));
  // Defence-in-depth: only merge active clusters that belong to this flow, even
  // if the model returned an id from elsewhere. proposeReshape is already given a
  // single flow's clusters, so this should never drop anything in practice.
  const clusters = fetched.filter(
    (c): c is GapClusterRecord => Boolean(c) && c?.status === "active" && sameFlow(c?.flowId, flowId)
  );
  if (clusters.length < 2) {
    return;
  }
  const survivorId = selectSurvivingClusterOnMerge(clusters.map((c) => ({ id: c.id, createdAt: c.createdAt })));
  const revision = await ctx.stores.questionLogs.getGapCatalogRevision(flowId);
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

async function applySplit(ctx: AppContext, split: ProposedSplit, flowId: string | undefined): Promise<void> {
  const original = await ctx.stores.gapClusters.getCluster(split.clusterId);
  if (!original || original.status !== "active" || !sameFlow(original.flowId, flowId)) {
    return;
  }
  const revision = await ctx.stores.questionLogs.getGapCatalogRevision(flowId);
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

// A proposal's owning flow is its cluster's flow; a cluster-less proposal belongs
// to the un-routed/default flow. Cached per run to avoid repeat cluster reads.
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

// The pending/failed publication actions whose proposal belongs to this flow.
// Orphaned actions (proposal already deleted) resolve to the default flow.
async function flowPendingActions(
  ctx: AppContext,
  flowId: string | undefined,
  cache: ClusterFlowCache
): Promise<PublicationActionRecord[]> {
  const all = await ctx.stores.gapClusters.listPendingPublicationActions();
  const mine: PublicationActionRecord[] = [];
  for (const action of all) {
    const proposal = await ctx.stores.proposals.get(action.proposalId);
    const flow = proposal ? await proposalFlowId(ctx, proposal, cache) : undefined;
    if (sameFlow(flow, flowId)) {
      mine.push(action);
    }
  }
  return mine;
}

async function drainPublicationOutbox(
  ctx: AppContext,
  flowId: string | undefined,
  deps: ReconcilerDeps,
  cache: ClusterFlowCache
): Promise<void> {
  const actions = await flowPendingActions(ctx, flowId, cache);
  if (actions.length === 0) {
    return;
  }
  const flowLabel = flowId ?? "default";
  console.log(`Gap reconciler [${flowLabel}]: draining ${actions.length} pending publication action(s).`);
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
  console.log(`Gap reconciler [${flowLabel}]: publication outbox drained — ${done} enqueued, ${failed} failed.`);
}

async function defaultPublish(ctx: AppContext, proposal: Proposal): Promise<void> {
  // Publication is enqueue-only: the API validates the repository pre-flight and
  // enqueues a publish_proposal job; the Task 7 watcher runner executes the git.
  const result = await proposalsService.requestProposalPublication(ctx, proposal);
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.message}`);
  }
}

async function defaultSupersede(_ctx: AppContext, _proposal: Proposal): Promise<void> {
  // Closing the PR on GitHub is host-specific; implemented when closePullRequest
  // lands in @magpie/git. Until then, the DB status is already 'superseded' and
  // this is a no-op that completes the action.
}
