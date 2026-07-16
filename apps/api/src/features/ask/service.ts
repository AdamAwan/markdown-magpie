import { randomUUID } from "node:crypto";
import type { JobView } from "@magpie/jobs";
import type { QuestionLog } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { HttpError } from "../../http/errors.js";
import { assertAiCapacity } from "../../platform/ai-capacity.js";
import { buildAnswerQuestionInput, recordAnswerQuestionLog } from "../../platform/answer-question.js";

interface AskResult {
  questionId: string;
  // The conversation this exchange belongs to (#239). Minted on the first turn and
  // echoed back so a client can attach follow-ups by passing it to POST /api/ask.
  conversationId: string;
  job: JobView;
}

// Sentinel meaning "let the watcher route this question" — the default when no
// flow is specified. Any other value must name a configured flow.
const AUTO_FLOW = "auto";

// Conversation-context bounds (#239). A follow-up carries at most the last
// MAX_PRIOR_TURNS answered turns, and each turn's answer is truncated to
// MAX_ANSWER_CHARS so a long prior answer cannot blow the job payload / model
// budget. Both are deliberately small: the context exists to resolve pronouns and
// keep routing sticky, not to re-feed the whole thread.
const MAX_PRIOR_TURNS = 6;
const MAX_ANSWER_CHARS = 1200;

// Enqueue-only: all generative work (routing, retrieval, answering) now happens
// in the watcher. The API records the question log and enqueues an
// answer_question job carrying the routing candidates; the watcher routes to a
// flow (or uses a caller-pinned one), calls POST /api/retrieve for scoped
// context, then answers.
//
// `flow` is the caller's choice: absent/"auto" routes as usual; any other value
// pins the question to that flow and must match a configured flow id (a 400
// otherwise, so a typo fails fast rather than silently answering unscoped).
//
// `conversationId` (#239) threads a follow-up onto a prior exchange: when present,
// the API reconstructs the conversation's recent Q&A turns (bounded) and its
// established flow, and passes both to the job so the watcher can condense the
// follow-up into a standalone query and keep routing sticky. Absent means a new
// conversation — the API mints an id and returns it either way.
export async function ask(
  ctx: AppContext,
  question: string,
  flow?: string,
  conversationId?: string
): Promise<AskResult> {
  const requestedFlowId = resolveRequestedFlow(ctx, flow);
  const conversation = conversationId ?? randomUUID();
  // Assemble prior-turn context BEFORE recording this turn's log, so the new
  // (answer-less) row can never appear in its own prior context.
  const { priorTurns, conversationFlowId } = await assembleConversationContext(ctx, conversationId);
  // Enforce the global in-flight AI-job ceiling BEFORE recording the question log
  // below, so a rejection at capacity never leaves an orphaned log with no job.
  await assertAiCapacity(ctx);
  const log = await recordAnswerQuestionLog(ctx, question, "live", conversation);
  const input = buildAnswerQuestionInput(ctx, {
    questionLogId: log.id,
    question,
    ...(requestedFlowId ? { requestedFlowId } : {}),
    ...(priorTurns.length > 0 ? { priorTurns } : {}),
    // The caller's explicit flow pin always wins over the sticky flow; only fall
    // back to the conversation's established flow when the caller left it to "auto".
    ...(!requestedFlowId && conversationFlowId ? { conversationFlowId } : {})
  });
  const job = await ctx.jobs.create("answer_question", input);
  return { questionId: log.id, conversationId: conversation, job };
}

// Reconstructs the bounded prior-turn context for a follow-up: the recent answered
// turns (question + truncated answer, oldest-first) and the flow the conversation
// has settled on (its most recent prior turn's flow). Returns empty context for a
// new/first-turn conversation.
async function assembleConversationContext(
  ctx: AppContext,
  conversationId: string | undefined
): Promise<{ priorTurns: Array<{ question: string; answer: string }>; conversationFlowId?: string }> {
  if (!conversationId) {
    return { priorTurns: [] };
  }
  const turns = await ctx.stores.questionLogs.listConversationTurns(conversationId, MAX_PRIOR_TURNS);
  const priorTurns = turns
    .map((turn) => ({ question: turn.question, answer: truncate(turn.answer?.answer ?? "") }))
    .filter((turn) => turn.answer.length > 0);
  return { priorTurns, ...stickyFlow(turns) };
}

// The flow the conversation has settled on: the most recent prior turn that was
// actually routed to a flow. Follow-ups reuse it so a terse "what about the EU?"
// stays in the same knowledge area rather than re-routing.
function stickyFlow(turns: QuestionLog[]): { conversationFlowId?: string } {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const flowId = turns[index]?.flowId;
    if (flowId) {
      return { conversationFlowId: flowId };
    }
  }
  return {};
}

function truncate(answer: string): string {
  return answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS)}…` : answer;
}

// Maps the caller's `flow` choice to a `requestedFlowId` for the job. Returns
// undefined for absent/"auto" (route as usual); throws a 400 for an id that is
// not a configured flow so the caller learns the value was rejected.
function resolveRequestedFlow(ctx: AppContext, flow: string | undefined): string | undefined {
  if (!flow || flow === AUTO_FLOW) {
    return undefined;
  }

  if (!ctx.knowledgeConfig.flows.some((configured) => configured.id === flow)) {
    throw new HttpError(400, "unknown_flow", `No configured flow with id "${flow}"`);
  }

  return flow;
}
