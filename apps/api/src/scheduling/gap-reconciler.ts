import { createHash } from "node:crypto";
import type { Proposal } from "@magpie/core";
import { fetchPullRequestStatus as defaultFetchPullRequestStatus } from "@magpie/git";
import { logger } from "../logger.js";
import { reconcileGapClustersOutputSchema, type JobState } from "@magpie/jobs";
import type { AppContext } from "../context.js";
import { withFlowRunLock } from "./run-lock.js";
import * as gapsService from "../features/gaps/service.js";
import { parseCompletedJobOutput, runJobToCompletion } from "../features/jobs/service.js";
import * as proposalsService from "../features/proposals/service.js";
import { type SourceContextCache } from "../platform/source-context.js";
import { describeFlowScope } from "../features/retrieve/service.js";
import type {
  GapClusterMembershipRecord,
  GapClusterRecord,
  PublicationActionRecord
} from "../stores/gap-cluster-store.js";
import { pairKey } from "../stores/pr-crosslink-store.js";
import { gapSummaryKey } from "../stores/question-log-store.js";
import { selectRetainingChildOnSplit, selectSurvivingClusterOnMerge } from "./gap-reconciler-lineage.js";
import { sharedTargets } from "./reconcile-gate.js";

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
interface ProposedDismissal {
  clusterId: string;
  rationale: string;
}

interface GapReconcileRunDetails extends Record<string, unknown> {
  catalogRevision: number;
  processedRevision: number;
  pendingPublicationActions: number;
  pullRequestsChecked: number;
  pullRequestTransitions: number;
  overlapsDetected: number;
  clustersCreated: number;
  mergeDecisions: number;
  splitDecisions: number;
  dismissDecisions: number;
  decisionsApplied: number;
  proposalsDrafted: number;
  publicationActionsDrained: number;
  skippedModelWork: boolean;
  // True when clustering ran but the metered propose→critic reshape was skipped
  // because the active cluster composition was byte-identical to the set already
  // judged at the last reshape (issue #168). Distinct from skippedModelWork, which
  // covers the whole clustering step being gated out by an unchanged revision.
  reshapeSkipped: boolean;
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
// Records one MaintenanceRun per reconcile tick (completed, or failed + rethrow) so
// the Schedules audit shows every run — including no-op ticks that changed nothing.
export async function reconcileGaps(
  ctx: AppContext,
  flowId: string | undefined,
  deps: ReconcilerDeps = DEFAULT_DEPS
): Promise<void> {
  // Serialize this flow's reconcile across every API instance (issue #167): pg-boss
  // dedupes the cron *enqueue* per slot but not *execution*, so a run outlasting its
  // cadence can overlap the next slot's run on a second watcher and double every
  // metered reshape + draft. The advisory lock covers both the cron path and the
  // manual "Run now" path, since both funnel through here. Only the run that holds
  // the lock records a MaintenanceRun; a skipped overlapping run did no work.
  const result = await withFlowRunLock(ctx.pool, "process_gaps_to_pull_requests", flowId, async () => {
    let details: GapReconcileRunDetails | undefined;
    try {
      details = await reconcileGapsInner(ctx, flowId, deps);
    } catch (error) {
      await ctx.stores.maintenanceRuns.record({
        taskType: "process_gaps_to_pull_requests",
        flowId,
        trigger: "scheduled",
        status: "failed",
        summary: `reconcile failed for flow ${flowId ?? "(default)"}`,
        error: error instanceof Error ? error.message : String(error),
        details: details ?? {}
      });
      throw error;
    }
    await ctx.stores.maintenanceRuns.record({
      taskType: "process_gaps_to_pull_requests",
      flowId,
      trigger: "scheduled",
      status: "completed",
      summary: `reconciled flow ${flowId ?? "(default)"}`,
      details: details ?? {}
    });
  });
  if (!result.acquired) {
    logger.info(
      { flowLabel: flowId ?? "default" },
      "gap reconciler: another reconcile for this flow is already running; skipped this overlapping run (issue #167)"
    );
  }
}

async function reconcileGapsInner(
  ctx: AppContext,
  flowId: string | undefined,
  deps: ReconcilerDeps = DEFAULT_DEPS
): Promise<GapReconcileRunDetails> {
  const flowLabel = flowId ?? "default";
  const clusterFlowCache: ClusterFlowCache = new Map();
  const details: GapReconcileRunDetails = {
    catalogRevision: 0,
    processedRevision: 0,
    pendingPublicationActions: 0,
    pullRequestsChecked: 0,
    pullRequestTransitions: 0,
    overlapsDetected: 0,
    clustersCreated: 0,
    mergeDecisions: 0,
    splitDecisions: 0,
    dismissDecisions: 0,
    decisionsApplied: 0,
    proposalsDrafted: 0,
    publicationActionsDrained: 0,
    skippedModelWork: false,
    reshapeSkipped: false
  };

  // (b) PR-state pass — only the open pull requests raised from this flow's proposals.
  const prState = await refreshOpenPullRequests(ctx, flowId, deps, clusterFlowCache);
  details.pullRequestsChecked = prState.checked;
  details.pullRequestTransitions = prState.transitions;

  details.overlapsDetected = await detectOverlaps(ctx, flowId, clusterFlowCache);

  const catalogRevision = await ctx.stores.questionLogs.getGapCatalogRevision(flowId);
  const processed = await ctx.stores.gapClusters.getProcessedRevision(flowId);
  const pending = await flowPendingActions(ctx, flowId, clusterFlowCache);
  details.catalogRevision = catalogRevision;
  details.processedRevision = processed;
  details.pendingPublicationActions = pending.length;

  // (a) Revision gate.
  if (catalogRevision === processed && pending.length === 0) {
    details.skippedModelWork = true;
    logger.info({ flowLabel, catalogRevision }, "gap reconciler: no gap changes and no pending publication actions; ran PR-state pass only");
    return details;
  }

  if (catalogRevision !== processed) {
    logger.info({ flowLabel, processed, catalogRevision }, "gap reconciler: gap catalog advanced; reconciling clusters");
    const clustering = await reconcileClusters(ctx, flowId);
    details.clustersCreated = clustering.clustersCreated;
    details.mergeDecisions = clustering.mergeDecisions;
    details.splitDecisions = clustering.splitDecisions;
    details.dismissDecisions = clustering.dismissDecisions;
    details.decisionsApplied = clustering.decisionsApplied;
    details.proposalsDrafted = clustering.proposalsDrafted;
    details.reshapeSkipped = clustering.reshapeSkipped;
    await ctx.stores.gapClusters.setProcessedRevision(flowId, catalogRevision, new Date().toISOString());
  } else {
    details.skippedModelWork = true;
    logger.info({ flowLabel, catalogRevision, pending: pending.length }, "gap reconciler: catalog revision unchanged; draining pending actions");
  }

  // (d) Outbox: retry this flow's pending/failed publication actions without re-running models.
  details.publicationActionsDrained = await drainPublicationOutbox(ctx, flowId, deps, clusterFlowCache);
  return details;
}

async function refreshOpenPullRequests(
  ctx: AppContext,
  flowId: string | undefined,
  deps: ReconcilerDeps,
  cache: ClusterFlowCache
): Promise<{ checked: number; transitions: number }> {
  // Prefer the PR state the fetch job already downloaded for this flow; only poll
  // the host live for a PR the snapshot hasn't covered yet (e.g. one opened since
  // the last fetch, or before the fetch job has ever run). This keeps the
  // reconciler off the network in the steady state. defaultPublish still re-checks
  // live state immediately before mutating, so acting on a snapshot reading can't
  // publish against a PR that changed since the fetch.
  const snapshot = await ctx.stores.snapshots.read(flowId);
  const snapshotByProposal = new Map((snapshot?.pullRequests ?? []).map((pr) => [pr.proposalId, pr]));

  const open = await ctx.stores.proposals.list(200, { status: "pr-opened" });
  let checked = 0;
  let transitions = 0;
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
        logger.warn({ proposalId: proposal.id, err: message }, "PR status check failed");
        continue;
      }
    }
    if (!status) {
      continue;
    }
    checked += 1;
    if (await applyPullRequestTransition(ctx, proposal.id, status)) {
      transitions += 1;
    }
  }
  return { checked, transitions };
}

// The merged/closed proposal transition, applied by BOTH this reconciler's PR-state
// pass and the refresh_flow_snapshot completion handler. Kept here and shared so the
// two paths can never drift: merged ⇒ updateStatus("merged") + runMergeCascade +
// freeze the cluster; a close-without-merge ⇒ updateStatus("rejected") + freeze.
// Idempotent by guarding on the proposal's CURRENT status: only a still-open
// (pr-opened) proposal is transitioned, so re-applying the same reading — e.g.
// re-completing a refresh_flow_snapshot job — is a no-op and never runs the cascade
// twice. (updateStatus itself returns the proposal even when nothing changed, so the
// guard, not its return value, is what makes this safe.)
export async function applyPullRequestTransition(
  ctx: AppContext,
  proposalId: string,
  status: { merged: boolean; state: "open" | "closed" }
): Promise<boolean> {
  const current = await ctx.stores.proposals.get(proposalId);
  if (!current || current.status !== "pr-opened") {
    return false;
  }
  if (status.merged) {
    const merged = await ctx.stores.proposals.updateStatus(proposalId, "merged");
    if (merged) {
      logger.info({ proposalId }, "gap reconciler: proposal merged; running cascade and freezing its cluster");
      await proposalsService.runMergeCascade(ctx, merged);
      await freezeClusterForProposal(ctx, merged);
      return true;
    }
  } else if (status.state === "closed") {
    const rejected = await ctx.stores.proposals.updateStatus(proposalId, "rejected");
    if (rejected) {
      logger.info({ proposalId }, "gap reconciler: proposal PR closed without merge; marked rejected and froze its cluster");
      await freezeClusterForProposal(ctx, rejected);
      return true;
    }
  }
  return false;
}

async function freezeClusterForProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.gapClusterId) {
    await ctx.stores.gapClusters.freezeCluster(proposal.gapClusterId);
  }
}

// (c) Clustering for one flow: assign the flow's new gaps, then propose
// merges/splits over the flow's active set and apply only the critic-confirmed
// changes. Everything is filtered to `flowId` so a reshape can never mix flows.
async function reconcileClusters(ctx: AppContext, flowId: string | undefined): Promise<
  Pick<
    GapReconcileRunDetails,
    | "clustersCreated"
    | "mergeDecisions"
    | "splitDecisions"
    | "dismissDecisions"
    | "decisionsApplied"
    | "proposalsDrafted"
    | "reshapeSkipped"
  >
> {
  const flowLabel = flowId ?? "default";
  const details = {
    clustersCreated: 0,
    mergeDecisions: 0,
    splitDecisions: 0,
    dismissDecisions: 0,
    decisionsApplied: 0,
    proposalsDrafted: 0,
    reshapeSkipped: false
  };

  // 0) Evict resolved gaps from whatever active cluster still holds them. A gap
  // is resolved by (question, summary) when its proposal merges, but a reshape
  // may have since moved that gap into a different cluster than the one the
  // merge froze. Pruning here keeps "active membership" meaning "this gap is in
  // this cluster AND still open", so a covered gap stops surfacing as a member
  // and never re-drafts. Resolution is global, so this is not flow-scoped.
  await pruneResolvedMemberships(ctx);

  // 0b) Freeze any of this flow's active clusters left with no live members
  // after pruning. Their content is fully covered, so they must not draft (or
  // keep) a proposal; freezing drops them from listActiveClusters.
  const emptied = await ctx.stores.gapClusters.listActiveClustersForFlow(flowId);
  for (const cluster of emptied) {
    const members = await ctx.stores.gapClusters.listMembershipsForCluster(cluster.id);
    if (members.length === 0) {
      await ctx.stores.gapClusters.freezeCluster(cluster.id);
      logger.info({ flowLabel, clusterId: cluster.id, clusterTitle: cluster.title }, "gap reconciler: froze cluster — all gaps resolved");
    }
  }

  // 1) Assign this flow's unassigned gaps to their own new cluster. The gap ids
  // for every candidate are resolved in ONE batched query (not one per
  // candidate), and only this flow's active memberships are loaded.
  const candidates = (await ctx.stores.questionLogs.listGapCandidates(200)).filter((c) => sameFlow(c.flowId, flowId));
  const activeMemberships = await ctx.stores.gapClusters.listActiveMembershipsForFlow(flowId);
  const assignedGapIds = new Set(activeMemberships.map((m) => m.gapId));
  const gapIdsByCandidate = await ctx.stores.questionLogs.gapIdsForSummaries(
    candidates.map((candidate) => ({ summary: candidate.summary, flowId: candidate.flowId }))
  );

  let clustersCreated = 0;
  for (const candidate of candidates) {
    const gapIds = gapIdsByCandidate.get(gapSummaryKey(candidate.summary, candidate.flowId)) ?? [];
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
    details.clustersCreated += 1;
    await ctx.stores.gapClusters.assignGapsToCluster(cluster.id, unassigned, "initial assignment");
    for (const gapId of unassigned) {
      assignedGapIds.add(gapId);
    }
  }
  logger.info({ flowLabel, clustersCreated }, "gap reconciler: created new clusters from unassigned gaps");

  // 2) Reshape this flow's active clusters. The propose→critic generative step now
  // runs as a reconcile_gap_clusters AI job in the watcher; the API enqueues it and
  // bounded-waits for the critic-confirmed verdicts. Runs whenever there is at least
  // one active cluster: a single cluster has nothing to merge/split, but it can still
  // be dismissed as off-topic (a lone "cats" cluster in a product flow). Reshape is
  // best-effort: when no chat watcher is available (timeout) or the job fails, we log
  // and skip, leaving the rest of reconcileGaps to run.
  const active = await ctx.stores.gapClusters.listActiveClustersForFlow(flowId);
  if (active.length >= 1) {
    // (#168) Short-circuit the metered propose→critic reshape when the active
    // cluster composition is byte-identical to the set already judged at the last
    // reshape. The revision gate only tells us SOME gap changed this cycle; a bump
    // that leaves the active cluster set (its ids + each cluster's membership gap
    // ids) unchanged — an identical-gap re-answer, a change elsewhere in the flow —
    // would otherwise re-run the full generation just to re-conclude "no merges,
    // splits, or dismissals". Any genuine change (a new/removed cluster, a gap
    // moving between clusters) changes the hash, so real work is never skipped.
    const memberships = await ctx.stores.gapClusters.listActiveMembershipsForFlow(flowId);
    const compositionHash = reshapeCompositionHash(active, memberships);
    const lastReshapeHash = await ctx.stores.gapClusters.getReshapeCompositionHash(flowId);
    if (compositionHash === lastReshapeHash) {
      details.reshapeSkipped = true;
      logger.info(
        { flowLabel, compositionHash, activeClusters: active.length },
        "gap reconciler: active cluster composition unchanged since last reshape; skipping propose→critic"
      );
    }
    const reshape = details.reshapeSkipped ? undefined : await requestReshape(ctx, active, flowId, flowLabel);
    if (reshape) {
      // 3) Apply only the critic-confirmed changes, recording every decision
      // (confirmed or not) so it's inspectable in the UI, not just in the logs.
      for (const merge of reshape.merges) {
        if (merge.clusterIds.length < 2) {
          continue;
        }
        details.mergeDecisions += 1;
        await ctx.stores.reconciliations.record({
          flowId,
          kind: "merge",
          rationale: merge.rationale,
          confirmed: merge.confirmed,
          applied: merge.confirmed,
          clusterIds: merge.clusterIds
        });
        if (!merge.confirmed) {
          logger.info({ flowLabel, clusterCount: merge.clusterIds.length }, "gap reconciler: critic rejected proposed merge");
          continue;
        }
        details.decisionsApplied += 1;
        logger.info({ flowLabel, clusterIds: merge.clusterIds }, "gap reconciler: critic confirmed merge of clusters");
        await applyMerge(ctx, { clusterIds: merge.clusterIds, rationale: merge.rationale }, flowId);
      }
      for (const split of reshape.splits) {
        if (split.children.length < 2) {
          continue;
        }
        details.splitDecisions += 1;
        await ctx.stores.reconciliations.record({
          flowId,
          kind: "split",
          rationale: split.rationale,
          confirmed: split.confirmed,
          applied: split.confirmed,
          clusterIds: [split.clusterId]
        });
        if (!split.confirmed) {
          logger.info({ flowLabel, clusterId: split.clusterId }, "gap reconciler: critic rejected proposed split");
          continue;
        }
        details.decisionsApplied += 1;
        logger.info({ flowLabel, clusterId: split.clusterId, childCount: split.children.length }, "gap reconciler: critic confirmed split of cluster");
        await applySplit(ctx, { clusterId: split.clusterId, children: split.children, rationale: split.rationale }, flowId);
      }
      // Dismissals run before drafting (step 4) so an off-topic cluster never becomes
      // a pull request. A confirmed dismissal drops the cluster and dismisses its
      // member gaps permanently, so it neither drafts nor re-clusters next run.
      for (const dismissal of reshape.dismissals) {
        details.dismissDecisions += 1;
        await ctx.stores.reconciliations.record({
          flowId,
          kind: "dismiss",
          rationale: dismissal.rationale,
          confirmed: dismissal.confirmed,
          applied: dismissal.confirmed,
          clusterIds: [dismissal.clusterId]
        });
        if (!dismissal.confirmed) {
          logger.info({ flowLabel, clusterId: dismissal.clusterId }, "gap reconciler: critic rejected proposed dismissal");
          continue;
        }
        details.decisionsApplied += 1;
        logger.info({ flowLabel, clusterId: dismissal.clusterId }, "gap reconciler: critic confirmed dismissal of off-topic cluster");
        await applyDismissal(ctx, { clusterId: dismissal.clusterId, rationale: dismissal.rationale }, flowId);
      }
      // Record the composition we just judged, so a later tick whose active set is
      // identical skips the reshape. Recorded ONLY here — inside the `reshape`
      // branch — so a skipped, timed-out, failed, or malformed reshape (all of
      // which leave `reshape` undefined) never marks an unjudged set as done and
      // wedges the gate. If a merge/split/dismissal was applied, the active set now
      // differs from this hash, so the next tick re-judges the new composition once.
      await ctx.stores.gapClusters.setReshapeCompositionHash(flowId, compositionHash);
    }
  }

  // 4) Draft a proposal for every active cluster in this flow that has none yet,
  // so a fresh cluster becomes a pull request autonomously instead of waiting for
  // a manual trigger. This is the autonomous gap->PR step the on-demand pipeline
  // used to do.
  details.proposalsDrafted = await draftProposalsForUncoveredClusters(ctx, flowId);
  return details;
}

// Drafts a proposal for each active cluster in this flow with no linked proposal.
// draftFromCluster links the proposal and enqueues its publish action, which
// drainPublicationOutbox processes in the same run. Frozen clusters (merged/
// rejected PRs) are excluded by listActiveClusters, so content a reviewer already
// declined is never re-raised.
async function draftProposalsForUncoveredClusters(ctx: AppContext, flowId: string | undefined): Promise<number> {
  const active = await ctx.stores.gapClusters.listActiveClustersForFlow(flowId);
  const proposals = await ctx.stores.proposals.list(500);
  const coveredClusterIds = new Set(
    proposals.map((p) => p.gapClusterId).filter((id): id is string => Boolean(id))
  );
  // Drafting is enqueue-only: a proposal row appears only when the
  // draft_markdown_proposal job completes (the gaps job-completion path links it to
  // its cluster). A draft still queued/active for a cluster therefore ALREADY covers
  // it even though no proposal exists yet. Counting those in-flight jobs — a
  // deterministic read of the job store — stops an overlapping reconcile (issue #167)
  // or a draft that outlives its tick from enqueueing a second full generation for
  // the same cluster.
  for (const clusterId of await inFlightDraftClusterIds(ctx)) {
    coveredClusterIds.add(clusterId);
  }

  // Collect each source set's context once for the whole run; clusters sharing a
  // flow (and so the same sources) reuse the bytes instead of re-walking the
  // checkout per draft.
  const sourceContextCache: SourceContextCache = new Map();

  let drafted = 0;
  for (const cluster of active) {
    if (coveredClusterIds.has(cluster.id)) {
      continue;
    }
    try {
      const outcome = await gapsService.draftFromCluster(ctx, cluster.id, { sourceContextCache });
      if (outcome.ok) {
        drafted += 1;
        logger.info({ flowId: flowId ?? "default", clusterId: cluster.id, clusterTitle: cluster.title, jobId: outcome.job.id }, "gap reconciler: enqueued draft for cluster");
      } else {
        logger.warn({ flowId: flowId ?? "default", clusterId: cluster.id, code: outcome.code }, "gap reconciler: could not draft proposal for cluster");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "draft failed";
      logger.warn({ flowId: flowId ?? "default", clusterId: cluster.id, err: message }, "gap reconciler: failed to draft proposal for cluster");
    }
  }
  logger.info({ flowId: flowId ?? "default", drafted }, "gap reconciler: drafted new proposals for uncovered clusters");
  return drafted;
}

// The non-terminal job states in which a draft is still "in flight" and so counts
// as covering its cluster. Matches the in-flight set the manual-run guard uses in
// scheduled-tasks/service.ts.
const IN_FLIGHT_DRAFT_STATES: ReadonlySet<JobState> = new Set<JobState>(["created", "active", "retry", "blocked"]);

// Cluster ids that already have a queued/active draft_markdown_proposal job. Read
// from the job store rather than the proposal store, so a cluster is treated as
// covered during the window between enqueue and the job completing (when no
// proposal row exists yet). Newest-first ordering keeps freshly enqueued in-flight
// jobs within the scanned page even when many completed drafts are retained.
async function inFlightDraftClusterIds(ctx: AppContext): Promise<Set<string>> {
  const { jobs } = await ctx.jobs.list({ type: "draft_markdown_proposal", limit: 200 });
  const clusterIds = new Set<string>();
  for (const job of jobs) {
    if (!IN_FLIGHT_DRAFT_STATES.has(job.state)) {
      continue;
    }
    const clusterId = draftJobClusterId(job.input);
    if (clusterId) {
      clusterIds.add(clusterId);
    }
  }
  return clusterIds;
}

// The gapClusterId carried on a draft_markdown_proposal job input, read defensively
// from the untyped stored envelope (the same shape-narrowing pattern inputFlowId
// uses in scheduled-tasks/service.ts).
function draftJobClusterId(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const clusterId = (input as { gapClusterId?: unknown }).gapClusterId;
  return typeof clusterId === "string" ? clusterId : undefined;
}

// Deactivates the membership of every active-cluster gap that has since been
// resolved, so a covered gap no longer counts as a live member anywhere.
async function pruneResolvedMemberships(ctx: AppContext): Promise<void> {
  const active = await ctx.stores.gapClusters.listActiveMemberships();
  if (active.length === 0) {
    return;
  }
  const gapIds = active.map((m) => m.gapId);
  const unresolved = new Set(await ctx.stores.questionLogs.listUnresolvedGapIds(gapIds));
  const resolved = gapIds.filter((id) => !unresolved.has(id));
  if (resolved.length > 0) {
    await ctx.stores.gapClusters.deactivateMembershipsForGaps(resolved);
  }
}

// Deterministic hash of a flow's active cluster composition: the sorted cluster
// ids, each paired with its sorted active-membership gap ids. Two calls hash to
// the same value exactly when the same clusters hold the same gaps, regardless of
// row order — so the reconciler can tell "the set the critic already judged" from
// "a genuinely changed set" (issue #168). Sorting is lexical, which is enough for
// determinism; the ids only need to compare equal across ticks, not by magnitude.
export function reshapeCompositionHash(
  clusters: GapClusterRecord[],
  memberships: GapClusterMembershipRecord[]
): string {
  const gapIdsByCluster = new Map<string, string[]>();
  for (const membership of memberships) {
    const bucket = gapIdsByCluster.get(membership.clusterId);
    if (bucket) {
      bucket.push(membership.gapId);
    } else {
      gapIdsByCluster.set(membership.clusterId, [membership.gapId]);
    }
  }
  const canonical = clusters
    .map((cluster) => cluster.id)
    .sort()
    .map((clusterId) => {
      const gapIds = [...(gapIdsByCluster.get(clusterId) ?? [])].sort();
      return `${clusterId}:[${gapIds.join(",")}]`;
    })
    .join(";");
  return createHash("sha256").update(canonical).digest("hex");
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
  // Attach scope grounding per cluster (persona + best retrieval relevance + closest
  // snippets, via inline retrieval against the flow's destination) so the model can
  // tell an off-topic cluster from an on-topic-but-uncovered one. The cluster title
  // is the gap summary, which is a good enough retrieval query for this judgement.
  const clusters = await Promise.all(
    active.map(async (c) => {
      const scope = await describeFlowScope(ctx, c.flowId ?? flowId, c.title);
      return {
        id: c.id,
        ...(c.flowId ? { flowId: c.flowId } : {}),
        title: c.title,
        ...(scope ? { scope } : {})
      };
    })
  );
  const input = {
    clusters,
    ...(flowId ? { flowId } : {}),
    provider: ctx.config.get().aiProvider
  };

  let terminal;
  try {
    terminal = await runJobToCompletion(ctx, "reconcile_gap_clusters", input, {
      reuseKey: reconcileGapClustersReuseKey
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "reshape job failed";
    logger.warn({ flowLabel, err: message }, "gap reconciler: reshape job could not be enqueued; skipping reshape");
    return undefined;
  }

  if (terminal.state !== "completed") {
    logger.warn({ flowLabel, jobId: terminal.id, state: terminal.state }, "gap reconciler: reshape job did not complete; skipping reshape this run");
    return undefined;
  }

  const parsed = parseCompletedJobOutput(reconcileGapClustersOutputSchema, terminal.output);
  if (!parsed) {
    logger.warn({ flowLabel, jobId: terminal.id }, "gap reconciler: reshape job returned malformed output; skipping reshape");
    return undefined;
  }
  return parsed;
}

// Dedupe key for reuseKey (#162): a reshape already in flight for this flow (and
// routed to the same provider) is the same piece of work a concurrent caller or
// the next cron tick would otherwise duplicate, so wait on it instead of
// enqueueing another. The default flow's undefined flowId is normalized to a
// stable sentinel so repeated default-flow reshapes still dedupe against each
// other rather than each producing a distinct "undefined" key.
function reconcileGapClustersReuseKey(input: unknown): string {
  if (!input || typeof input !== "object") return "unknown";
  const candidate = input as { flowId?: unknown; provider?: unknown };
  const flowId = typeof candidate.flowId === "string" ? candidate.flowId : "__default__";
  const provider = typeof candidate.provider === "string" ? candidate.provider : "__unknown__";
  return `${provider}:${flowId}`;
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

// Permanently drops an off-topic cluster: dismiss its underlying gaps (so they never
// resurface as candidates or re-cluster) then dismiss the cluster itself (so it
// leaves the active set and never drafts). Defence-in-depth: only a still-active
// cluster of this flow is dismissed, matching applyMerge/applySplit.
async function applyDismissal(ctx: AppContext, dismissal: ProposedDismissal, flowId: string | undefined): Promise<void> {
  const cluster = await ctx.stores.gapClusters.getCluster(dismissal.clusterId);
  if (!cluster || cluster.status !== "active" || !sameFlow(cluster.flowId, flowId)) {
    return;
  }
  const members = await ctx.stores.gapClusters.listMembershipsForCluster(cluster.id);
  const gapIds = members.map((member) => member.gapId);
  if (gapIds.length > 0) {
    await ctx.stores.questionLogs.dismissGaps(gapIds, dismissal.rationale);
  }
  await ctx.stores.gapClusters.dismissCluster(cluster.id, dismissal.rationale);
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
  // Targeted lookup: the cluster's linked proposal, instead of reloading the
  // whole proposal list on every call. getByClusterId mirrors the old
  // list(500).find() semantics (terminal statuses excluded, newest first).
  return ctx.stores.proposals.getByClusterId(clusterId);
}

// A proposal's owning flow is its cluster's flow; a cluster-less proposal belongs
// to the un-routed/default flow. Cached per run to avoid repeat cluster reads.
async function proposalFlowId(
  ctx: AppContext,
  proposal: Proposal,
  cache: ClusterFlowCache
): Promise<string | undefined> {
  if (proposal.flowId) {
    return proposal.flowId;
  }
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
): Promise<number> {
  const actions = await flowPendingActions(ctx, flowId, cache);
  if (actions.length === 0) {
    return 0;
  }
  const flowLabel = flowId ?? "default";
  logger.info({ flowLabel, pending: actions.length }, "gap reconciler: draining pending publication actions");
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
      logger.warn({ actionId: action.id, kind: action.kind, proposalId: action.proposalId, err: message }, "publication action failed");
    }
  }
  logger.info({ flowLabel, done, failed }, "gap reconciler: publication outbox drained");
  return done;
}

// Observe-first overlap detection: when two of this flow's open PRs touch the
// same file, cross-link them once. Uses the spine's sharedTargets; records each
// pair in prCrosslinks so a pair is linked once, not every tick. Best-effort —
// a per-pair failure is logged and never aborts reconcileGaps.
async function detectOverlaps(
  ctx: AppContext,
  flowId: string | undefined,
  cache: ClusterFlowCache
): Promise<number> {
  const open = await ctx.stores.proposals.list(200, { status: "pr-opened" });
  const candidates: Array<{ id: string; targetPath: string; pullRequestUrl: string }> = [];
  for (const proposal of open) {
    if (!sameFlow(await proposalFlowId(ctx, proposal, cache), flowId)) {
      continue;
    }
    const pullRequestUrl = proposal.publication?.pullRequestUrl;
    if (!pullRequestUrl || !proposal.targetPath) {
      continue;
    }
    candidates.push({ id: proposal.id, targetPath: proposal.targetPath, pullRequestUrl });
  }

  // Only PRs touching the same file can overlap (sharedTargets([a],[b]) is
  // non-empty exactly when a.targetPath === b.targetPath), so group by path and
  // only compare within a group instead of every pair. The pairs are still
  // visited in (i, j) index order, so the records, jobs, and logs come out
  // identical to the old nested loop — just without the wasted cross-path work.
  const byPath = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const bucket = byPath.get(candidate.targetPath);
    if (bucket) {
      bucket.push(index);
    } else {
      byPath.set(candidate.targetPath, [index]);
    }
  });
  const overlappingPairs: Array<[number, number]> = [];
  for (const indices of byPath.values()) {
    for (let a = 0; a < indices.length; a += 1) {
      for (let b = a + 1; b < indices.length; b += 1) {
        overlappingPairs.push([indices[a], indices[b]]);
      }
    }
  }
  overlappingPairs.sort((l, r) => (l[0] - r[0]) || (l[1] - r[1]));

  // One query loads every already-linked pair among the candidates, replacing the
  // per-pair has() round-trip in the loop below.
  const linked = await ctx.stores.prCrosslinks.existingPairs(candidates.map((candidate) => candidate.id));

  let detected = 0;
  for (const [i, j] of overlappingPairs) {
    const a = candidates[i];
    const b = candidates[j];
    const targets = sharedTargets([a.targetPath], [b.targetPath]);
    if (targets.length === 0) {
      continue;
    }
    try {
      if (linked.has(pairKey(a.id, b.id))) {
        continue;
      }
      await ctx.stores.prCrosslinks.record({ flowId, proposalA: a.id, proposalB: b.id, targets });
      detected += 1;
      await ctx.jobs.create("crosslink_pull_requests", {
        ...(flowId ? { flowId } : {}),
        targets,
        pullRequests: [
          { proposalId: a.id, pullRequestUrl: a.pullRequestUrl },
          { proposalId: b.id, pullRequestUrl: b.pullRequestUrl }
        ]
      });
      logger.info({ flowId: flowId ?? "default", proposalA: a.id, proposalB: b.id, targets }, "gap reconciler: cross-linked overlapping PRs");
    } catch (error) {
      const message = error instanceof Error ? error.message : "overlap cross-link failed";
      logger.warn({ proposalA: a.id, proposalB: b.id, err: message }, "overlap cross-link failed");
    }
  }
  return detected;
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
