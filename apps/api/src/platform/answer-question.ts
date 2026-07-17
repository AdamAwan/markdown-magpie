import type { AnswerCandidate, AnswerQuestionJobInput, QuestionLog, QuestionPurpose } from "@magpie/core";
import type { AppContext } from "../context.js";
import type { AiProviderName } from "./providers.js";

// Shared by the two answer_question enqueue sites — the live /ask path
// (features/ask/service.ts) and the gap-closure re-ask path
// (features/proposals/service.ts verifyGapClosure) — so the re-ask path can
// never silently drift from how a live question is asked. Deliberately does
// NOT carry the behavioural differences between the two callers
// (assertAiCapacity, resolveRequestedFlow's 400 on an unknown flow id): the
// live path enforces those before calling in here, the re-ask path does not
// (see verifyGapClosure's resolveVerificationFlowId for why a stale flowId is
// dropped rather than rejected there) — only the construction plumbing is
// shared.

// Records a fresh question log for an answer_question enqueue. Flow and
// retrieved sections are unknown at enqueue time (the watcher decides them),
// so the log is recorded without them; completion fills them in. `purpose`
// defaults to "live"; the gap-closure re-ask path passes "verification" so the
// synthetic log stays out of gap candidacy, the questions list, and clustering
// (#154); questionnaire item asks pass "questionnaire" (in candidacy, out of
// the questions list — docs/questionnaires.md).
export async function recordAnswerQuestionLog(
  ctx: AppContext,
  question: string,
  purpose: QuestionPurpose = "live",
  conversationId?: string
): Promise<QuestionLog> {
  return ctx.stores.questionLogs.record({
    question,
    chatProvider: ctx.config.get().aiProvider,
    retrievedSectionIds: [],
    purpose,
    ...(conversationId ? { conversationId } : {})
  });
}

// Builds the answer_question job input: the flows roster (from the current
// knowledge config) plus the caller-supplied questionLogId/question/
// requestedFlowId and the configured provider.
export function buildAnswerQuestionInput(
  ctx: AppContext,
  options: {
    questionLogId: string;
    question: string;
    requestedFlowId?: string;
    // Multi-turn conversation context (#239), assembled by the ask service from the
    // conversation's prior question logs (bounded). Omitted on the first turn.
    priorTurns?: Array<{ question: string; answer: string }>;
    conversationFlowId?: string;
    // Prior approved items the watcher's reconciler can reuse/adapt/merge from
    // (questionnaire trust, docs/questionnaires.md). Absent for non-questionnaire
    // questions and for questionnaires with no approved match candidates.
    candidates?: AnswerCandidate[];
  }
): AnswerQuestionJobInput & { provider: AiProviderName } {
  const flows = ctx.knowledgeConfig.flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    ...(flow.persona ? { persona: flow.persona } : {})
  }));

  return {
    questionLogId: options.questionLogId,
    question: options.question,
    flows,
    ...(options.requestedFlowId ? { requestedFlowId: options.requestedFlowId } : {}),
    ...(options.priorTurns && options.priorTurns.length > 0 ? { priorTurns: options.priorTurns } : {}),
    ...(options.conversationFlowId ? { conversationFlowId: options.conversationFlowId } : {}),
    ...(options.candidates ? { candidates: options.candidates } : {}),
    provider: ctx.config.get().aiProvider,
    expectedOutput: "answer_result"
  };
}
