import type { ParkedQuestion, QuestionFeedback, QuestionLog } from "@magpie/core";
import type { AppContext } from "../../context.js";

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

// One page of the question list plus the unpaginated total, so the console can
// page through the full history (same shape as the knowledge list endpoints).
export async function listQuestions(
  ctx: AppContext,
  pagination: { limit: number; offset: number }
): Promise<{ questions: QuestionLog[]; total: number }> {
  const [questions, total] = await Promise.all([
    ctx.stores.questionLogs.list(pagination.limit, pagination.offset),
    ctx.stores.questionLogs.count()
  ]);
  return { questions, total };
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
