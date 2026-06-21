import type { ChatProvider } from "@magpie/core";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import { answerQuestionInputSchema } from "@magpie/jobs";
import { ANSWER_QUESTION, withPersona } from "@magpie/prompts";
import { routeQuestionToFlow, type RoutableFlow } from "@magpie/retrieval";
import type { WatcherApi } from "../http-client.js";
import { buildAnswerOutput, buildPrompt, parseJobOutput } from "../job-prompts.js";

// The AI job types a hosted chat provider can execute. Publication (github) and
// maintenance jobs are handled by other runners.
const CHAT_JOB_TYPES: ReadonlySet<JobType> = new Set([
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "crunch_knowledge_base",
  "cluster_gap_candidates"
]);

// Runs AI jobs through an OpenAI-compatible or Azure OpenAI chat provider. The
// capability (openai-compatible / azure-openai) is whatever queue the watcher
// claimed from, so the API has already matched provider to runner.
//
// answer_question is special: routing and retrieval happen here in the watcher
// (route -> retrieve -> answer), and citations are derived from the retrieved
// sections rather than trusted from the model.
export class ChatRunner {
  constructor(
    readonly capability: Extract<JobCapability, "openai-compatible" | "azure-openai">,
    private readonly chat: ChatProvider,
    private readonly api: WatcherApi
  ) {}

  supports(type: JobType): boolean {
    return CHAT_JOB_TYPES.has(type);
  }

  async run(job: JobView, signal: AbortSignal): Promise<unknown> {
    if (job.type === "answer_question") {
      return this.answer(job, signal);
    }

    const response = await this.chat.complete({
      system: ANSWER_QUESTION.instructions,
      messages: [{ role: "user", content: buildPrompt(job) }],
      signal
    });
    return parseJobOutput(job, response.content);
  }

  private async answer(job: JobView, signal: AbortSignal): Promise<unknown> {
    const input = answerQuestionInputSchema.parse(job.input);
    const flows: RoutableFlow[] = input.flows.map((flow) => ({
      id: flow.id,
      name: flow.name,
      ...(flow.persona ? { persona: flow.persona } : {})
    }));

    // 1. Route the question to the best-matching flow (a generative call). When
    //    routing degrades (no flows, provider error), flowId stays undefined and
    //    retrieval runs unscoped.
    const decision = await routeQuestionToFlow(input.question, flows, this.chat);
    const flowId = decision?.flowId;
    const routedFlow = flowId ? flows.find((flow) => flow.id === flowId) : undefined;

    // 2. Retrieve the scoped sections from the API (the watcher cannot reach
    //    pgvector itself).
    const sections = await this.api.retrieve(input.question, flowId, undefined);

    // 3. Answer using those sections, applying the routed flow's persona.
    const context = sections.map((section) => `# ${section.heading}\n${section.content}`).join("\n\n");
    const response = await this.chat.complete({
      system: withPersona(ANSWER_QUESTION.instructions, routedFlow?.persona),
      messages: [{ role: "user", content: `Question:\n${input.question}\n\nContext:\n${context}` }],
      signal
    });

    // 4. Build the output, deriving citations from the retrieved sections and
    //    recording the routed flow.
    return buildAnswerOutput(response.content, sections, input.question, flowId);
  }
}
