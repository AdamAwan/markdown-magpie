import type { Proposal } from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import { foldMarkdownProposalOutputSchema } from "@magpie/jobs";
import type { AppContext } from "../context.js";
import { splitGapSummaries } from "../features/proposals/service.js";
import type { ChangeIntent } from "./intent.js";
import { decideReconciliation, openPullRequestSummaries } from "./reconcile-gate.js";

function sameFlow(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

// A proposal's owning flow is its cluster's flow; a cluster-less proposal belongs
// to the un-routed/default flow.
async function proposalFlowId(ctx: AppContext, proposal: Proposal): Promise<string | undefined> {
  if (!proposal.gapClusterId) {
    return undefined;
  }
  const cluster = await ctx.stores.gapClusters.getCluster(proposal.gapClusterId);
  return cluster?.flowId;
}

// At-draft fold: when a freshly-created draft proposal overlaps a touchable open
// proposal in the SAME flow, enqueue a fold_markdown_proposal job to merge them.
// Best-effort and only acts on the `fold` verdict; open-new/defer leave the draft
// untouched. The caller (completeJob) guards against this throwing.
export async function reconcileDraftedProposal(ctx: AppContext, rival: Proposal): Promise<void> {
  // Only intercept a still-draft rival; an already-published proposal is out of
  // scope for the at-draft hook.
  if (rival.status !== "draft" || !rival.targetPath) {
    return;
  }

  const flowId = await proposalFlowId(ctx, rival);
  const candidates: Proposal[] = [];
  for (const proposal of await ctx.stores.proposals.list(200)) {
    if (proposal.id === rival.id) {
      continue;
    }
    if (!sameFlow(await proposalFlowId(ctx, proposal), flowId)) {
      continue;
    }
    candidates.push(proposal);
  }

  const intent: ChangeIntent = {
    lens: "gap",
    flowId,
    targets: [rival.targetPath],
    evidence: rival.evidence.map((citation) => citation.path),
    rationale: rival.rationale ?? ""
  };
  const decision = decideReconciliation(intent, openPullRequestSummaries(candidates));
  // The only overlap is an approved (non-touchable) PR: folding would invalidate the
  // review, so publish the rival as its own PR instead. Nothing auto-publishes a
  // fresh draft otherwise, so this is a deliberate action; the #21 cross-link
  // backstop then flags the overlap to the approved PR's owner.
  if (decision.kind === "defer") {
    await ctx.stores.gapClusters.enqueuePublicationAction(rival.id, "publish");
    console.log(`Defer: rival ${rival.id} overlaps only approved PR(s); enqueued it to publish as its own PR.`);
    return;
  }
  if (decision.kind !== "fold") {
    return;
  }

  const survivor = await ctx.stores.proposals.get(decision.intoProposalId);
  if (!survivor) {
    return;
  }

  await ctx.jobs.create("fold_markdown_proposal", {
    provider: ctx.config.get().aiProvider,
    survivorProposalId: survivor.id,
    rivalProposalId: rival.id,
    targetPath: rival.targetPath,
    survivorMarkdown: survivor.markdown,
    rivalMarkdown: rival.markdown,
    rivalGapSummaries: splitGapSummaries(rival.gapSummary),
    rivalEvidence: rival.evidence,
    expectedOutput: "folded_markdown"
  });
  console.log(
    `Fold: enqueued fold_markdown_proposal to merge rival ${rival.id} into ${survivor.id} on ${rival.targetPath}.`
  );
}

// Applies a completed fold: update the survivor's markdown, absorb the rival's gap
// cluster into the survivor's (so the rival's gaps resolve when the survivor merges),
// supersede the rival, and re-publish the survivor through the outbox. Idempotent on
// a rival that is already superseded.
export async function applyFoldFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<void> {
  if (!job || job.type !== "fold_markdown_proposal") {
    return;
  }
  const parsed = foldMarkdownProposalOutputSchema.safeParse(output);
  if (!parsed.success) {
    return;
  }
  const input = job.input as { survivorProposalId?: string; rivalProposalId?: string };
  if (!input.survivorProposalId || !input.rivalProposalId) {
    return;
  }
  const survivor = await ctx.stores.proposals.get(input.survivorProposalId);
  const rival = await ctx.stores.proposals.get(input.rivalProposalId);
  if (!survivor || !rival || rival.status === "superseded") {
    return;
  }

  await ctx.stores.proposals.updateMarkdown(survivor.id, parsed.data.markdown);

  if (survivor.gapClusterId && rival.gapClusterId && survivor.gapClusterId !== rival.gapClusterId) {
    const members = await ctx.stores.gapClusters.listMembershipsForCluster(rival.gapClusterId);
    for (const member of members) {
      await ctx.stores.gapClusters.assignGapToCluster(survivor.gapClusterId, member.gapId, "folded");
    }
    await ctx.stores.gapClusters.freezeCluster(rival.gapClusterId);
  }

  await ctx.stores.proposals.updateStatus(rival.id, "superseded");
  await ctx.stores.gapClusters.enqueuePublicationAction(survivor.id, "publish");

  const pullRequestUrl = survivor.publication?.pullRequestUrl;
  if (pullRequestUrl) {
    await ctx.jobs.create("comment_pull_request", {
      pullRequestUrl,
      body:
        `🪶 **Magpie:** folded "${rival.title}" into this PR — it covered overlapping gaps on ` +
        `\`${survivor.targetPath}\`. This PR has been updated to include that material. ` +
        "_(automated fold-on-overlap)_"
    });
  }
  console.log(`Fold: merged rival ${rival.id} into survivor ${survivor.id}; survivor re-publish enqueued.`);
}

// Fold failed terminally: publish the rival as its own PR so its gap is never lost.
// The #21 cross-link backstop then catches the A/B overlap. Only acts on a rival
// still in draft (nothing was applied).
export async function enqueueFoldFallback(ctx: AppContext, job: JobView | undefined): Promise<void> {
  if (!job || job.type !== "fold_markdown_proposal") {
    return;
  }
  const input = job.input as { rivalProposalId?: string };
  if (!input.rivalProposalId) {
    return;
  }
  const rival = await ctx.stores.proposals.get(input.rivalProposalId);
  if (!rival || rival.status !== "draft") {
    return;
  }
  await ctx.stores.gapClusters.enqueuePublicationAction(rival.id, "publish");
  console.log(`Fold fallback: fold job ${job.id} failed; enqueued rival ${rival.id} to publish as its own PR.`);
}
