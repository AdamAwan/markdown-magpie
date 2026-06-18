import type { QuestionFeedback, QuestionLog } from "@magpie/core";
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
