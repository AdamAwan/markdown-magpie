import type { AnswerQuestionJobInput } from "@magpie/core";
import { answerQuestion } from "@magpie/retrieval";
import type { JobView } from "@magpie/jobs";
import { isAiProviderName } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import type { AiProviderName } from "../../platform/providers.js";

type AskResult =
  | {
      kind: "queue";
      questionId: string;
      job: JobView;
    }
  | {
      kind: "direct";
      mode: string;
      questionId: string;
      result: Awaited<ReturnType<typeof answerQuestion>>;
    };

export async function ask(ctx: AppContext, question: string): Promise<AskResult> {
  if (ctx.config.get().aiExecutionMode === "queue") {
    const sections = await ctx.stores.knowledgeIndex.search(question, 5);
    const log = await ctx.stores.questionLogs.record({
      question,
      executionMode: ctx.config.get().aiExecutionMode,
      chatProvider: ctx.config.get().aiProvider,
      retrievedSectionIds: sections.map((ranked) => ranked.section.id)
    });
    // The @magpie/jobs schema requires a concrete AI provider (not "mock").
    // "mock" is a local execution shim; for job creation default to "openai-compatible".
    const configuredProvider = ctx.config.get().aiProvider;
    const jobProvider = isAiProviderName(configuredProvider) ? configuredProvider : "openai-compatible";
    const input: AnswerQuestionJobInput & { provider: AiProviderName } = {
      questionLogId: log.id,
      question,
      context: sections.map(({ section }) => ({
        sectionId: section.id,
        path: section.path,
        heading: section.heading,
        content: section.content
      })),
      provider: jobProvider,
      expectedOutput: "answer_result"
    };
    const job = await ctx.jobs.create("answer_question", input);
    return { kind: "queue", questionId: log.id, job };
  }

  const result = await answerQuestion(
    question,
    ctx.stores.knowledgeIndex,
    ctx.providers.chat(ctx.config.get().aiProvider)
  );
  const log = await ctx.stores.questionLogs.record({
    question,
    executionMode: ctx.config.get().aiExecutionMode,
    chatProvider: ctx.config.get().aiProvider,
    answer: result,
    retrievedSectionIds: result.citations.map((citation) => citation.sectionId)
  });

  return { kind: "direct", mode: ctx.config.get().aiExecutionMode, questionId: log.id, result };
}
