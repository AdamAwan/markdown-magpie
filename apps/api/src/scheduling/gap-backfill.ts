import type { Proposal } from "@magpie/core";
import type { AppContext } from "../context.js";
import { splitGapSummaries } from "../features/proposals/service.js";

// Proposal statuses whose cluster should be created frozen: the work is settled,
// so the cluster is a historical record the reconciler must never reshape.
const SETTLED_STATUSES: ReadonlySet<Proposal["status"]> = new Set(["merged", "rejected", "superseded"]);

// One-shot, idempotent migration that gives every pre-existing proposal a gap
// cluster, mirroring the model the reconciler now maintains. Runs on boot only
// when no clusters exist yet but proposals do, so re-running it (or booting an
// already-migrated DB) is a no-op.
//
// A gap referenced by more than one proposal is claimed by the first proposal to
// reach it, and proposals are ordered active-first then by id, so an in-flight
// proposal wins a gap over a settled one. The active-membership uniqueness this
// preserves matches the reconciler's own invariant: each gap has at most one
// active cluster membership.
export async function backfillGapClusters(ctx: AppContext): Promise<void> {
  const existing = await ctx.stores.gapClusters.listActiveClusters();
  if (existing.length > 0) {
    return; // already migrated (or the reconciler has run) — nothing to do.
  }

  const proposals = await listAllProposals(ctx);
  if (proposals.length === 0) {
    return;
  }

  const revision = await ctx.stores.questionLogs.getGapCatalogRevision();
  const claimedGapIds = new Set<string>();
  let created = 0;

  for (const proposal of orderActiveFirst(proposals)) {
    const settled = SETTLED_STATUSES.has(proposal.status);
    const cluster = await ctx.stores.gapClusters.createCluster({
      title: clusterTitle(proposal),
      rationale: proposal.rationale,
      revision
    });
    created += 1;

    for (const summary of splitGapSummaries(proposal.gapSummary)) {
      const gapIds = await ctx.stores.questionLogs.gapIdsForSummary(summary);
      for (const gapId of gapIds) {
        if (claimedGapIds.has(gapId)) {
          continue; // a higher-priority proposal already owns this gap.
        }
        await ctx.stores.gapClusters.assignGapToCluster(cluster.id, gapId, "backfill");
        claimedGapIds.add(gapId);
      }
    }

    await ctx.stores.proposals.linkCluster(proposal.id, cluster.id);
    if (settled) {
      await ctx.stores.gapClusters.freezeCluster(cluster.id);
    }
  }

  console.log(`Backfilled ${created} gap cluster(s) for ${proposals.length} existing proposal(s).`);
}

// proposals.list omits merged rows by default, so the settled history is fetched
// separately and merged in. Other terminal statuses (rejected/superseded) are
// already included in the default list.
async function listAllProposals(ctx: AppContext): Promise<Proposal[]> {
  const [active, merged] = await Promise.all([
    ctx.stores.proposals.list(1000),
    ctx.stores.proposals.list(1000, { status: "merged" })
  ]);
  return [...active, ...merged];
}

// Active (in-flight) proposals first so they win a shared gap; ties broken by id
// for a deterministic claim order, matching the backfill spec.
function orderActiveFirst(proposals: Proposal[]): Proposal[] {
  return [...proposals].sort((left, right) => {
    const leftSettled = SETTLED_STATUSES.has(left.status) ? 1 : 0;
    const rightSettled = SETTLED_STATUSES.has(right.status) ? 1 : 0;
    if (leftSettled !== rightSettled) {
      return leftSettled - rightSettled;
    }
    return left.id.localeCompare(right.id);
  });
}

function clusterTitle(proposal: Proposal): string {
  return (proposal.title?.trim() || "Knowledge Gap").slice(0, 80);
}
