import type {
  AgentRunner,
  AiJob,
  AiJobType,
  AnswerQuestionJobInput,
  AnswerQuestionJobOutput,
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput,
  SummarizeGapJobInput,
  SummarizeGapJobOutput
} from "@magpie/core";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const watcherName = process.env.WATCHER_NAME ?? "local-dev-watcher";
const provider = process.env.AI_JOB_PROVIDER ?? "mock";
const pollIntervalMs = Number.parseInt(process.env.WATCHER_POLL_INTERVAL_MS ?? "2000", 10);
const acceptedTypes: AiJobType[] = [
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation"
];

let shuttingDown = false;

process.on("SIGINT", () => {
  shuttingDown = true;
});

process.on("SIGTERM", () => {
  shuttingDown = true;
});

async function poll(): Promise<void> {
  while (!shuttingDown) {
    try {
      const job = await claimNextJob();
      if (!job) {
        await sleep(pollIntervalMs);
        continue;
      }

      console.log(`Claimed ${job.type} job ${job.id}`);
      await runAndComplete(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown watcher error";
      console.error(`Watcher loop error: ${message}`);
      await sleep(pollIntervalMs);
    }
  }

  console.log(`Markdown Magpie watcher '${watcherName}' stopped`);
}

async function claimNextJob(): Promise<AiJob | undefined> {
  const result = await postJson<{ job: AiJob | null }>("/ai-jobs/claim", {
    workerName: watcherName,
    acceptedTypes
  });

  return result.job ?? undefined;
}

async function runAndComplete(job: AiJob): Promise<void> {
  try {
    if (!runner.supports(job.type)) {
      throw new Error(`${runner.name} does not support ${job.type}`);
    }

    const output = await runner.run(job);
    await postJson(`/ai-jobs/${job.id}/complete`, { output });
    console.log(`Completed ${job.type} job ${job.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown job failure";
    await postJson(`/ai-jobs/${job.id}/fail`, { error: message });
    console.error(`Failed ${job.type} job ${job.id}: ${message}`);
  }
}

function createRunner(name: string): AgentRunner {
  if (name === "codex") {
    return new CliAgentRunner("codex", process.env.CODEX_CLI_PATH ?? "codex");
  }

  if (name === "claude") {
    return new CliAgentRunner("claude", process.env.CLAUDE_CLI_PATH ?? "claude");
  }

  return new MockAgentRunner();
}

class MockAgentRunner implements AgentRunner {
  readonly name = "mock";

  supports() {
    return true;
  }

  async run(job: AiJob): Promise<unknown> {
    if (job.type === "answer_question") {
      return this.answerQuestion(job.input as AnswerQuestionJobInput);
    }

    if (job.type === "summarize_gap") {
      return this.summarizeGap(job.input as SummarizeGapJobInput);
    }

    if (job.type === "draft_markdown_proposal") {
      return this.draftMarkdownProposal(job.input as DraftMarkdownProposalJobInput);
    }

    return {
      provider: this.name,
      status: "not_enough_signal",
      summary: `Mock runner received ${job.type}, but no specialist handler exists yet.`
    };
  }

  private answerQuestion(input: AnswerQuestionJobInput): AnswerQuestionJobOutput {
    if (input.context.length === 0) {
      return {
        answer: "I could not find reliable source material for this question.",
        confidence: "low",
        citations: [],
        gap: {
          summary: `No source material found for: ${input.question}`,
          question: input.question,
          confidence: "low",
          citedSectionIds: []
        }
      };
    }

    return {
      answer: `Mock answer for: ${input.question}`,
      confidence: "medium",
      citations: input.context.map((section) => ({
        documentId: section.path,
        sectionId: section.sectionId,
        path: section.path,
        heading: section.heading,
        anchor: section.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        excerpt: section.content.slice(0, 280)
      }))
    };
  }

  private summarizeGap(input: SummarizeGapJobInput): SummarizeGapJobOutput {
    return {
      summary: input.questions[0] ?? "Unanswered knowledge gap",
      priority: input.questions.length,
      rationale: `Mock priority is based on ${input.questions.length} triggering question(s).`
    };
  }

  private draftMarkdownProposal(input: DraftMarkdownProposalJobInput): DraftMarkdownProposalJobOutput {
    return {
      title: input.gapSummary,
      targetPath: input.targetPath ?? "docs/proposed/knowledge-gap.md",
      markdown: `---\ntitle: ${input.gapSummary}\nstatus: draft\n---\n\n# ${input.gapSummary}\n\nTODO: Review and expand this proposed article.\n`,
      rationale: `Mock proposal generated from ${input.triggeringQuestions.length} triggering question(s).`
    };
  }
}

class CliAgentRunner implements AgentRunner {
  constructor(
    public readonly name: string,
    private readonly command: string
  ) {}

  supports() {
    return true;
  }

  async run(job: AiJob): Promise<unknown> {
    return {
      jobId: job.id,
      provider: this.name,
      command: this.command,
      status: "not_implemented",
      note: "CLI execution needs a prompt/output contract and workspace permission policy before it is enabled."
    };
  }
}

const runner = createRunner(provider);

console.log(`Markdown Magpie watcher '${watcherName}' starting`);
console.log(`API: ${apiBaseUrl}`);
console.log(`Provider: ${runner.name}`);
console.log(`Accepted jobs: ${acceptedTypes.join(", ")}`);

void poll();

async function postJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as TResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
