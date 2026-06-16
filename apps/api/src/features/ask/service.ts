import type { AnswerQuestionJobInput } from "@magpie/core";
import { answerQuestion } from "@magpie/retrieval";
import type { AppContext } from "../../context.js";
import type { AiProviderName } from "../../platform/providers.js";

type AskResult =
  | {
      kind: "queue";
      questionId: string;
      job: Awaited<ReturnType<AppContext["stores"]["aiJobs"]["enqueue"]>>;
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
    const input: AnswerQuestionJobInput = {
      questionLogId: log.id,
      question,
      context: sections.map(({ section }) => ({
        sectionId: section.id,
        path: section.path,
        heading: section.heading,
        content: section.content
      })),
      provider: ctx.config.get().aiProvider,
      expectedOutput: "answer_result"
    } as AnswerQuestionJobInput & { provider: AiProviderName };
    const job = await ctx.stores.aiJobs.enqueue("answer_question", input);
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
