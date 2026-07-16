import type { ParkedQuestion, Proposal, QuestionFeedback, QuestionLog } from "@magpie/core";
import type { AppContext } from "../../context.js";

// Title/rationale we overwrite an emptied cluster with, so no question-derived
// label survives a scrub.
const SCRUBBED_PLACEHOLDER = "[scrubbed]";

// A proposal the scrub left untouched because it is already published (a pushed
// branch / open PR / merged doc): un-publishing is a human action, so the caller
// surfaces these for manual handling instead of touching the remote.
export interface PublishedProposalWarning {
  proposalId: string;
  title: string;
  status: Proposal["status"];
  pullRequestUrl?: string;
}

export interface QuestionDeletionReport {
  deleted: {
    question: boolean;
    // Gap rows removed with the question (cascade). Zero when it had no gaps.
    gaps: number;
    // Emptied clusters dismissed + title-scrubbed (scrub mode only).
    clustersDismissed: number;
    // Still-populated clusters whose representative embedding was cleared for a
    // lazy recompute (scrub mode only).
    clustersRecomputed: number;
    // Unpublished proposals hard-deleted (scrub mode only).
    proposals: number;
  };
  warnings: PublishedProposalWarning[];
}

export async function recordFeedback(
  ctx: AppContext,
  questionId: string,
  feedback: QuestionFeedback
): Promise<QuestionLog | undefined> {
  return ctx.stores.questionLogs.recordFeedback(questionId, feedback);
}

export async function recordManualGap(
  ctx: AppContext,
  questionId: string,
  summary: string | undefined
): Promise<QuestionLog | undefined> {
  return ctx.stores.questionLogs.recordManualGap(questionId, summary);
}

export async function clearManualGap(ctx: AppContext, questionId: string): Promise<QuestionLog | undefined> {
  return ctx.stores.questionLogs.clearManualGap(questionId);
}

export async function getQuestion(ctx: AppContext, id: string): Promise<QuestionLog | undefined> {
  return ctx.stores.questionLogs.get(id);
}

// Purges a logged question that contained sensitive information. `scrub: false`
// deletes only the question record (the DB cascade takes its citations, gaps and
// cluster memberships). `scrub: true` also cleans the downstream artifacts the
// question's text propagated into: the gap clusters its gaps belonged to, and the
// proposals it seeded. Published proposals (a pushed branch / open PR / merged
// doc) are never touched — they are returned as warnings for a human to handle.
// Returns undefined when no such question exists (the route maps that to 404).
export async function deleteQuestion(
  ctx: AppContext,
  id: string,
  options: { scrub: boolean }
): Promise<QuestionDeletionReport | undefined> {
  const existing = await ctx.stores.questionLogs.get(id);
  if (!existing) {
    return undefined;
  }

  // Captured before deletion: the ids line up with cluster memberships (which the
  // question delete cascades away), so the affected clusters must be resolved now.
  const gapIds = await ctx.stores.questionLogs.gapIdsForQuestion(id);

  if (!options.scrub) {
    await ctx.stores.questionLogs.delete(id);
    return {
      deleted: { question: true, gaps: gapIds.length, clustersDismissed: 0, clustersRecomputed: 0, proposals: 0 },
      warnings: []
    };
  }

  const affectedClusterIds = await ctx.stores.gapClusters.clusterIdsForGaps(gapIds);
  const triggeredProposals = await ctx.stores.proposals.listByTriggeringQuestionId(id);

  // Delete the question (cascade removes citations/gaps/memberships in Postgres),
  // then normalise the in-memory cluster store — a no-op in Postgres where the
  // cascade already dropped the memberships.
  await ctx.stores.questionLogs.delete(id);
  await ctx.stores.gapClusters.deactivateMembershipsForGaps(gapIds);

  let clustersDismissed = 0;
  let clustersRecomputed = 0;
  for (const clusterId of affectedClusterIds) {
    const remaining = await ctx.stores.gapClusters.listMembershipsForCluster(clusterId);
    if (remaining.length === 0) {
      // The deleted question was this cluster's only source: its title/rationale
      // may echo the sensitive gap summary, so dismiss it out of the active set
      // and overwrite the label.
      await ctx.stores.gapClusters.dismissCluster(clusterId, SCRUBBED_PLACEHOLDER);
      await ctx.stores.gapClusters.updateCluster(clusterId, {
        title: SCRUBBED_PLACEHOLDER,
        rationale: SCRUBBED_PLACEHOLDER
      });
      clustersDismissed += 1;
    } else {
      // Other gaps still populate the cluster; clear its representative embedding
      // so the next assignment pass recomputes the centroid without the deleted
      // gap. The multi-gap title is left for the reconciler to re-derive.
      await ctx.stores.gapClusters.setClusterRepresentative(clusterId, null);
      clustersRecomputed += 1;
    }
  }

  let proposalsDeleted = 0;
  const warnings: PublishedProposalWarning[] = [];
  for (const proposal of triggeredProposals) {
    if (proposal.publication) {
      warnings.push({
        proposalId: proposal.id,
        title: proposal.title,
        status: proposal.status,
        ...(proposal.publication.pullRequestUrl ? { pullRequestUrl: proposal.publication.pullRequestUrl } : {})
      });
    } else {
      await ctx.stores.proposals.delete(proposal.id);
      proposalsDeleted += 1;
    }
  }

  return {
    deleted: { question: true, gaps: gapIds.length, clustersDismissed, clustersRecomputed, proposals: proposalsDeleted },
    warnings
  };
}

// One page of the question list plus two unpaginated counts, so the console can
// page through the full history (same shape as the knowledge list endpoints).
// `search` narrows the page to questions whose text contains it: `matching` is
// that filtered set's size (what the pager slices), while `total` stays the
// whole live backlog (what the sidebar badge reports).
export async function listQuestions(
  ctx: AppContext,
  options: { limit: number; offset: number; search?: string }
): Promise<{ questions: QuestionLog[]; total: number; matching: number }> {
  const search = options.search?.trim() || undefined;
  const [questions, total, matching] = await Promise.all([
    ctx.stores.questionLogs.list(options.limit, options.offset, search),
    ctx.stores.questionLogs.count(),
    search ? ctx.stores.questionLogs.count(search) : undefined
  ]);
  return { questions, total, matching: matching ?? total };
}

// A human re-admits a parked question to the pipeline (see the parked-gap
// workflow, issue #158).
export async function retryParkedGap(ctx: AppContext, questionId: string): Promise<QuestionLog | undefined> {
  return ctx.stores.questionLogs.retryParkedGap(questionId);
}

// A human abandons a parked question's topic.
export async function dismissParkedGap(ctx: AppContext, questionId: string): Promise<QuestionLog | undefined> {
  return ctx.stores.questionLogs.dismissParkedGap(questionId);
}

// A proposal parked with `closure_status = needs_attention` but no parked gap
// row: its triggering question log was deleted before verification, so the
// escalation would otherwise be invisible (#158 M1). Read-only on the surface.
interface ParkedProposal {
  proposalId: string;
  title: string;
  reason: "triggering_question_deleted";
}

export interface ParkedView {
  questions: ParkedQuestion[];
  proposals: ParkedProposal[];
}

export async function listParked(ctx: AppContext, limit: number): Promise<ParkedView> {
  const questions = await ctx.stores.questionLogs.listParkedQuestions(limit);
  // The missing-log escalation: a needs_attention proposal whose triggering
  // question logs are ALL gone files no parked gap, so surface it here (with a
  // distinct reason) rather than leaving the badge deep-link empty. A proposal
  // whose triggering questions still exist produced (or produced-then-settled) a
  // real parked question and is not re-surfaced at the proposal level.
  const needsAttention = await ctx.stores.proposals.listByClosureStatus("needs_attention", limit);
  // A proposal whose triggering question is currently parked already appears under
  // `questions`; skip it without a lookup (the bulk of needs_attention proposals),
  // so we only fetch logs for the candidates that could be a missing-log case
  // (#158 review #5).
  const parkedIds = new Set(questions.map((q) => q.questionId));
  const proposals: ParkedProposal[] = [];
  for (const proposal of needsAttention) {
    const triggeringIds = proposal.triggeringQuestionIds ?? [];
    if (triggeringIds.length === 0 || triggeringIds.some((qid) => parkedIds.has(qid))) {
      continue;
    }
    const logs = await Promise.all(triggeringIds.map((id) => ctx.stores.questionLogs.get(id)));
    if (logs.every((log) => !log)) {
      proposals.push({ proposalId: proposal.id, title: proposal.title, reason: "triggering_question_deleted" });
    }
  }
  return { questions, proposals };
}
