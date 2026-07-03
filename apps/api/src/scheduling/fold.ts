import type { Proposal } from "@magpie/core";
import { logger } from "../logger.js";
import type { JobView } from "@magpie/jobs";
import { foldChangesetProposalOutputSchema, foldMarkdownProposalOutputSchema } from "@magpie/jobs";
import type { AppContext } from "../context.js";
import { enqueuePublishProposal, splitGapSummaries } from "../features/proposals/service.js";
import type { ChangeIntent } from "./intent.js";
import { decideReconciliation, openPullRequestSummaries, sharedTargets } from "./reconcile-gate.js";
import { proposalFlowId, sameFlowOpenProposals } from "./flow.js";
import { proposalChangeset, proposalTargets } from "./changeset.js";

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
  const candidates = await sameFlowOpenProposals(ctx, flowId, rival.id);

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
    logger.info({ rivalId: rival.id }, "defer: rival overlaps only approved PRs; enqueued to publish as its own PR");
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
  logger.info({ rivalId: rival.id, survivorId: survivor.id, targetPath: rival.targetPath }, "fold: enqueued fold_markdown_proposal");
}

// Gate + publish a corrective (verify-lens) proposal. Unlike the gap at-draft hook,
// this OWNS publication: a clusterless patrol proposal is not published by the gap
// cluster reconciler, so open-new and defer both publish it as its own PR; only a
// touchable overlap folds. Best-effort — the caller (completeJob) guards throws.
export async function reconcileCorrectiveProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.status !== "draft" || !proposal.targetPath) {
    return;
  }
  const flowId = await proposalFlowId(ctx, proposal);
  const candidates = await sameFlowOpenProposals(ctx, flowId, proposal.id);
  const intent: ChangeIntent = {
    lens: "verify",
    flowId,
    targets: [proposal.targetPath],
    evidence: proposal.evidence.map((citation) => citation.path),
    rationale: proposal.rationale ?? ""
  };
  const decision = decideReconciliation(intent, openPullRequestSummaries(candidates));

  if (decision.kind === "fold") {
    const survivor = await ctx.stores.proposals.get(decision.intoProposalId);
    if (survivor) {
      await ctx.jobs.create("fold_markdown_proposal", {
        provider: ctx.config.get().aiProvider,
        survivorProposalId: survivor.id,
        rivalProposalId: proposal.id,
        targetPath: proposal.targetPath,
        survivorMarkdown: survivor.markdown,
        rivalMarkdown: proposal.markdown,
        rivalGapSummaries: [],
        rivalEvidence: proposal.evidence,
        expectedOutput: "folded_markdown"
      });
      logger.info({ proposalId: proposal.id, survivorId: survivor.id, targetPath: proposal.targetPath }, "verify fold: enqueued fold of corrective proposal");
      return;
    }
    // Survivor vanished between gate and fetch — fall through to self-publish.
  }

  // open-new, defer, or a fold whose survivor disappeared: publish as its own PR.
  await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");
  logger.info({ proposalId: proposal.id, decision: decision.kind, targetPath: proposal.targetPath }, "verify corrective: enqueued to publish");
}

// Gate + publish a dedupe proposal — the multi-file analogue of
// reconcileCorrectiveProposal. It gates on the proposal's whole file-set (both docs the
// dedupe touches), and OWNS publication: open-new and defer self-publish; a touchable
// overlap enqueues a fold_changeset_proposal job (the multi-file fold). Best-effort —
// the caller (completeJob) guards throws.
export async function reconcileDedupeProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.status !== "draft" || !proposal.targetPath) {
    return;
  }
  const flowId = await proposalFlowId(ctx, proposal);
  const candidates = await sameFlowOpenProposals(ctx, flowId, proposal.id);
  const targets = proposalTargets(proposal);
  const intent: ChangeIntent = {
    lens: "dedupe",
    flowId,
    targets,
    evidence: proposal.evidence.map((citation) => citation.path),
    rationale: proposal.rationale ?? ""
  };
  const decision = decideReconciliation(intent, openPullRequestSummaries(candidates));

  if (decision.kind === "fold") {
    const survivor = await ctx.stores.proposals.get(decision.intoProposalId);
    if (survivor) {
      await ctx.jobs.create("fold_changeset_proposal", {
        provider: ctx.config.get().aiProvider,
        survivorProposalId: survivor.id,
        rivalProposalId: proposal.id,
        survivorChangeset: proposalChangeset(survivor),
        rivalChangeset: proposalChangeset(proposal),
        sharedPaths: sharedTargets(proposalTargets(survivor), targets),
        expectedOutput: "folded_changeset"
      });
      logger.info({ proposalId: proposal.id, survivorId: survivor.id, targets }, "dedupe fold: enqueued fold of proposal");
      return;
    }
    // Survivor vanished between gate and fetch — fall through to self-publish.
  }

  // open-new, defer, or a fold whose survivor disappeared: publish as its own PR.
  await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");
  logger.info({ proposalId: proposal.id, decision: decision.kind, targets }, "dedupe: enqueued to publish");
}

// Gate + publish a split proposal. This is intentionally the same ownership model
// as dedupe: a clusterless multi-file patrol proposal gates on its whole file-set,
// self-publishes when clear/deferred, and folds through fold_changeset_proposal when
// a touchable same-flow PR overlaps any touched path.
export async function reconcileSplitProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.status !== "draft" || !proposal.targetPath) {
    return;
  }
  const flowId = await proposalFlowId(ctx, proposal);
  const candidates = await sameFlowOpenProposals(ctx, flowId, proposal.id);
  const targets = proposalTargets(proposal);
  const intent: ChangeIntent = {
    lens: "split",
    flowId,
    targets,
    evidence: proposal.evidence.map((citation) => citation.path),
    rationale: proposal.rationale ?? ""
  };
  const decision = decideReconciliation(intent, openPullRequestSummaries(candidates));

  if (decision.kind === "fold") {
    const survivor = await ctx.stores.proposals.get(decision.intoProposalId);
    if (survivor) {
      await ctx.jobs.create("fold_changeset_proposal", {
        provider: ctx.config.get().aiProvider,
        survivorProposalId: survivor.id,
        rivalProposalId: proposal.id,
        survivorChangeset: proposalChangeset(survivor),
        rivalChangeset: proposalChangeset(proposal),
        sharedPaths: sharedTargets(proposalTargets(survivor), targets),
        expectedOutput: "folded_changeset"
      });
      logger.info({ proposalId: proposal.id, survivorId: survivor.id, targets }, "split fold: enqueued fold of proposal");
      return;
    }
  }

  await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");
  logger.info({ proposalId: proposal.id, decision: decision.kind, targets }, "split: enqueued to publish");
}

// Gate + publish a source-sync proposal. Mirrors the dedupe/split multi-file model:
// a touchable overlap enqueues fold_changeset_proposal; clear or non-touchable overlap
// self-publishes as a proposal PR.
export async function reconcileSourceSyncProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.status !== "draft" || !proposal.targetPath) {
    return;
  }
  const flowId = await proposalFlowId(ctx, proposal);
  const candidates = await sameFlowOpenProposals(ctx, flowId, proposal.id);
  const targets = proposalTargets(proposal);
  const intent: ChangeIntent = {
    lens: "source-sync",
    flowId,
    targets,
    evidence: proposal.draftContext?.sourceFiles.map((source) => source.path ?? source.url ?? source.sourceName) ?? [],
    rationale: proposal.rationale ?? ""
  };
  const decision = decideReconciliation(intent, openPullRequestSummaries(candidates));

  if (decision.kind === "fold") {
    const survivor = await ctx.stores.proposals.get(decision.intoProposalId);
    if (survivor) {
      await ctx.jobs.create("fold_changeset_proposal", {
        provider: ctx.config.get().aiProvider,
        survivorProposalId: survivor.id,
        rivalProposalId: proposal.id,
        survivorChangeset: proposalChangeset(survivor),
        rivalChangeset: proposalChangeset(proposal),
        sharedPaths: sharedTargets(proposalTargets(survivor), targets),
        expectedOutput: "folded_changeset"
      });
      logger.info({ proposalId: proposal.id, survivorId: survivor.id, targets }, "source-sync fold: enqueued fold of proposal");
      return;
    }
  }

  await enqueuePublishProposal(ctx, proposal);
  logger.info({ proposalId: proposal.id, decision: decision.kind, targets }, "source-sync: enqueued to publish");
}

// Gate + publish an improve proposal. Improve-patrol is the single-file analogue
// of the verify corrective flow, but it represents editorial growth rather than a
// demonstrated fix. It owns publication because it is clusterless.
export async function reconcileImproveProposal(ctx: AppContext, proposal: Proposal): Promise<void> {
  if (proposal.status !== "draft" || !proposal.targetPath) {
    return;
  }
  const flowId = await proposalFlowId(ctx, proposal);
  const candidates = await sameFlowOpenProposals(ctx, flowId, proposal.id);
  const intent: ChangeIntent = {
    lens: "complete",
    flowId,
    targets: [proposal.targetPath],
    evidence: proposal.evidence.map((citation) => citation.path),
    rationale: proposal.rationale ?? ""
  };
  const decision = decideReconciliation(intent, openPullRequestSummaries(candidates));

  if (decision.kind === "fold") {
    const survivor = await ctx.stores.proposals.get(decision.intoProposalId);
    if (survivor) {
      await ctx.jobs.create("fold_markdown_proposal", {
        provider: ctx.config.get().aiProvider,
        survivorProposalId: survivor.id,
        rivalProposalId: proposal.id,
        targetPath: proposal.targetPath,
        survivorMarkdown: survivor.markdown,
        rivalMarkdown: proposal.markdown,
        rivalGapSummaries: [],
        rivalEvidence: proposal.evidence,
        expectedOutput: "folded_markdown"
      });
      logger.info({ proposalId: proposal.id, survivorId: survivor.id, targetPath: proposal.targetPath }, "improve fold: enqueued fold of proposal");
      return;
    }
  }

  await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");
  logger.info({ proposalId: proposal.id, decision: decision.kind, targetPath: proposal.targetPath }, "improve: enqueued to publish");
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

  // A changeset survivor (dedupe/split) publishes from its `changeset`, not its
  // `markdown` (see publishProposal in the watcher). Folding a single-file rival into
  // it must therefore write the merged content into the changeset's primary entry —
  // updating `markdown` alone would be silently discarded at publish time. A plain
  // single-file survivor keeps the markdown-only path.
  const changeset = survivor.changeset;
  const hasPrimaryWrite = changeset?.some((change) => change.path === survivor.targetPath && !change.delete);
  if (changeset && hasPrimaryWrite) {
    const merged = changeset.map((change) =>
      change.path === survivor.targetPath && !change.delete ? { ...change, content: parsed.data.markdown } : change
    );
    await ctx.stores.proposals.updateChangeset(survivor.id, merged, parsed.data.markdown);
  } else {
    await ctx.stores.proposals.updateMarkdown(survivor.id, parsed.data.markdown);
  }

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
  logger.info({ rivalId: rival.id, survivorId: survivor.id }, "fold: merged rival into survivor; survivor re-publish enqueued");
}

// Applies a completed multi-file fold: promote the survivor to the merged file-set
// (replacing its changeset and refreshing the primary markdown), supersede the rival,
// and re-publish the survivor through the outbox. The multi-file analogue of
// applyFoldFromCompletedJob; dedupe proposals are clusterless, so there is no gap
// cluster to absorb. Idempotent on a rival that is already superseded.
export async function applyChangesetFoldFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<void> {
  if (!job || job.type !== "fold_changeset_proposal") {
    return;
  }
  const parsed = foldChangesetProposalOutputSchema.safeParse(output);
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

  // The survivor's primary doc keeps its targetPath; its body becomes that path's new
  // content in the merged changeset (falling back to the existing markdown if, oddly,
  // the merge dropped the primary path).
  const primaryMarkdown =
    parsed.data.changeset.find((change) => change.path === survivor.targetPath)?.content ?? survivor.markdown;
  await ctx.stores.proposals.updateChangeset(survivor.id, parsed.data.changeset, primaryMarkdown);
  await ctx.stores.proposals.updateStatus(rival.id, "superseded");
  await ctx.stores.gapClusters.enqueuePublicationAction(survivor.id, "publish");

  const pullRequestUrl = survivor.publication?.pullRequestUrl;
  if (pullRequestUrl) {
    await ctx.jobs.create("comment_pull_request", {
      pullRequestUrl,
      body:
        `🪶 **Magpie:** folded "${rival.title}" into this PR — it reconciles overlapping documents. ` +
        "This PR has been updated to include that material. _(automated fold-on-overlap)_"
    });
  }
  logger.info({ rivalId: rival.id, survivorId: survivor.id }, "changeset fold: merged rival into survivor; survivor re-publish enqueued");
}

// Fold failed terminally: publish the rival as its own PR so its change is never lost.
// The #21 cross-link backstop then catches the overlap. Only acts on a rival still in
// draft (nothing was applied). Handles both the single-file and multi-file fold jobs.
export async function enqueueFoldFallback(ctx: AppContext, job: JobView | undefined): Promise<void> {
  if (!job || (job.type !== "fold_markdown_proposal" && job.type !== "fold_changeset_proposal")) {
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
  logger.info({ jobId: job.id, rivalId: rival.id }, "fold fallback: fold job failed; enqueued rival to publish as its own PR");
}
