import type { JobView } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { HttpError } from "../../http/errors.js";
import { assertAiCapacity } from "../../platform/ai-capacity.js";
import { buildAnswerQuestionInput, recordAnswerQuestionLog } from "../../platform/answer-question.js";

interface AskResult {
  questionId: string;
  job: JobView;
}

// Sentinel meaning "let the watcher route this question" — the default when no
// flow is specified. Any other value must name a configured flow.
const AUTO_FLOW = "auto";

// Enqueue-only: all generative work (routing, retrieval, answering) now happens
// in the watcher. The API records the question log and enqueues an
// answer_question job carrying the routing candidates; the watcher routes to a
// flow (or uses a caller-pinned one), calls POST /api/retrieve for scoped
// context, then answers.
//
// `flow` is the caller's choice: absent/"auto" routes as usual; any other value
// pins the question to that flow and must match a configured flow id (a 400
// otherwise, so a typo fails fast rather than silently answering unscoped).
export async function ask(ctx: AppContext, question: string, flow?: string): Promise<AskResult> {
  const requestedFlowId = resolveRequestedFlow(ctx, flow);
  // Enforce the global in-flight AI-job ceiling BEFORE recording the question log
  // below, so a rejection at capacity never leaves an orphaned log with no job.
  await assertAiCapacity(ctx);
  const log = await recordAnswerQuestionLog(ctx, question);
  const input = buildAnswerQuestionInput(ctx, { questionLogId: log.id, question, requestedFlowId });
  const job = await ctx.jobs.create("answer_question", input);
  return { questionId: log.id, job };
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
