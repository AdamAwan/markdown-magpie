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

export async function listQuestions(ctx: AppContext, limit: number): Promise<QuestionLog[]> {
  return ctx.stores.questionLogs.list(limit);
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

export async function listParkedQuestions(ctx: AppContext, limit: number): Promise<ParkedQuestion[]> {
  return ctx.stores.questionLogs.listParkedQuestions(limit);
}
