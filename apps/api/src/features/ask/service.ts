import type { AnswerQuestionJobInput } from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import type { AiProviderName } from "../../platform/providers.js";

interface AskResult {
  questionId: string;
  job: JobView;
}

// Enqueue-only: all generative work (routing, retrieval, answering) now happens
// in the watcher. The API records the question log and enqueues an
// answer_question job carrying the routing candidates; the watcher routes to a
// flow, calls POST /api/retrieve for scoped context, then answers.
export async function ask(ctx: AppContext, question: string): Promise<AskResult> {
  // Flow and retrieved sections are unknown at enqueue time (the watcher decides
  // them), so the log is recorded without them; completion fills them in.
  const log = await ctx.stores.questionLogs.record({
    question,
    executionMode: ctx.config.get().aiExecutionMode,
    chatProvider: ctx.config.get().aiProvider,
    retrievedSectionIds: []
  });

  const flows = ctx.knowledgeConfig.flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    ...(flow.persona ? { persona: flow.persona } : {})
  }));

  const input: AnswerQuestionJobInput & { provider: AiProviderName } = {
    questionLogId: log.id,
    question,
    flows,
    provider: ctx.config.get().aiProvider,
    expectedOutput: "answer_result"
  };

  const job = await ctx.jobs.create("answer_question", input);
  return { questionId: log.id, job };
}
