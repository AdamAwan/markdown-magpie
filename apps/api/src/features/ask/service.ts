import type { AnswerQuestionJobInput, ChatProvider } from "@magpie/core";
import { answerQuestion, routeQuestionToFlow } from "@magpie/retrieval";
import type { AppContext } from "../../context.js";
import type { AiProviderName } from "../../platform/providers.js";
import { selectFlow } from "../../platform/repositories.js";

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

interface RoutedFlow {
  flowId?: string;
  repositoryIds?: string[];
  persona?: string;
}

export async function ask(ctx: AppContext, question: string): Promise<AskResult> {
  // Route first: the chosen flow scopes retrieval (its destination) and supplies
  // the persona, in both execution modes, so flow selection has a single home here.
  const { flowId, repositoryIds, persona } = await routeToFlow(ctx, question);

  if (ctx.config.get().aiExecutionMode === "queue") {
    const sections = await ctx.stores.knowledgeIndex.search(question, 5, repositoryIds);
    const log = await ctx.stores.questionLogs.record({
      question,
      executionMode: ctx.config.get().aiExecutionMode,
      chatProvider: ctx.config.get().aiProvider,
      retrievedSectionIds: sections.map((ranked) => ranked.section.id),
      ...(flowId ? { flowId } : {})
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
      // Carry the routed flow + persona so the watcher (no flow config) applies the
      // persona via buildJobPrompt.
      ...(flowId ? { flowId } : {}),
      ...(persona ? { persona } : {}),
      provider: ctx.config.get().aiProvider,
      expectedOutput: "answer_result"
    } as AnswerQuestionJobInput & { provider: AiProviderName };
    const job = await ctx.stores.aiJobs.enqueue("answer_question", input);
    return { kind: "queue", questionId: log.id, job };
  }

  const result = await answerQuestion(
    question,
    ctx.stores.knowledgeIndex,
    ctx.providers.chat(ctx.config.get().aiProvider),
    { repositoryIds, persona }
  );
  const log = await ctx.stores.questionLogs.record({
    question,
    executionMode: ctx.config.get().aiExecutionMode,
    chatProvider: ctx.config.get().aiProvider,
    answer: result,
    retrievedSectionIds: result.citations.map((citation) => citation.sectionId),
    ...(flowId ? { flowId } : {})
  });

  return { kind: "direct", mode: ctx.config.get().aiExecutionMode, questionId: log.id, result };
}

// Resolves the flow that should answer this question. With zero or one configured
// flow there is nothing to route, so selectFlow short-circuits. With several, an AI
// call picks the best match; an unknown/failed decision falls back to the first flow.
async function routeToFlow(ctx: AppContext, question: string): Promise<RoutedFlow> {
  const deps = ctx.repositoryDeps();
  const flows = ctx.knowledgeConfig.flows;
  let chosen = selectFlow(deps, undefined);

  if (flows.length > 1) {
    const provider = routingChatProvider(ctx);
    const decision = provider
      ? await routeQuestionToFlow(
          question,
          flows.map((flow) => ({ id: flow.id, name: flow.name, persona: flow.persona })),
          provider
        )
      : undefined;
    chosen = selectFlow(deps, decision?.flowId) ?? flows[0];
  }

  return {
    flowId: chosen?.id,
    repositoryIds: chosen?.destinationId ? [chosen.destinationId] : undefined,
    persona: chosen?.persona
  };
}

// A synchronous chat provider for routing. Queue-only providers (codex/claude CLI)
// cannot be constructed in the API and throw here; in that case routing is skipped
// and the caller falls back to the default/first flow rather than failing the ask.
function routingChatProvider(ctx: AppContext): ChatProvider | undefined {
  try {
    return ctx.providers.chat(ctx.config.get().aiProvider);
  } catch {
    return undefined;
  }
}
