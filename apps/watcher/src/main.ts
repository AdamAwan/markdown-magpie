import type { AgentRunner, AiJob, AiJobType } from "@magpie/core";

const watcherName = process.env.WATCHER_NAME ?? "local-dev-watcher";
const provider = process.env.AI_JOB_PROVIDER ?? "mock";
const acceptedTypes: AiJobType[] = [
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation"
];

const runner = createRunner(provider);

console.log(`Markdown Magpie watcher '${watcherName}' starting`);
console.log(`Provider: ${runner.name}`);
console.log(`Accepted jobs: ${acceptedTypes.join(", ")}`);
console.log("Queue polling is not wired yet. This process defines the local agent-provider boundary.");

function createRunner(name: string): AgentRunner {
  if (name === "codex") {
    return new CliAgentRunner("codex", process.env.CODEX_CLI_PATH ?? "codex");
  }

  if (name === "claude") {
    return new CliAgentRunner("claude", process.env.CLAUDE_CLI_PATH ?? "claude");
  }

  return {
    name: "mock",
    supports() {
      return true;
    },
    async run(job: AiJob) {
      return {
        jobId: job.id,
        provider: "mock",
        content: "Mock watcher result. Configure AI_JOB_PROVIDER=codex or claude to use a local agent CLI."
      };
    }
  };
}

class CliAgentRunner implements AgentRunner {
  constructor(
    public readonly name: string,
    private readonly command: string
  ) {}

  supports() {
    return true;
  }

  async run(job: AiJob) {
    return {
      jobId: job.id,
      provider: this.name,
      command: this.command,
      status: "not_implemented",
      note: "CLI execution will be added once the AI job API contract is finalized."
    };
  }
}
