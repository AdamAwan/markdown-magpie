import { spawn, type ChildProcess } from "node:child_process";
import type {
  AgentRunner,
  AiJob,
  AiJobType,
  AnswerQuestionJobInput,
  AnswerQuestionJobOutput,
  CrunchKnowledgeBaseJobInput,
  CrunchKnowledgeBaseJobOutput,
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput,
  SummarizeGapJobInput,
  SummarizeGapJobOutput
} from "@magpie/core";
import { buildMockCrunchPlan, resolveProposalTargetPath } from "@magpie/core";
import { buildPrompt, parseJobOutput } from "./job-prompts.js";
import { JOB_RUNNER_SYSTEM } from "@magpie/prompts";

const apiBaseUrl = trimTrailingSlash(process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/api$/, "");
const watcherName = process.env.WATCHER_NAME ?? "local-dev-watcher";
const defaultProvider = process.env.AI_PROVIDER ?? process.env.AI_JOB_PROVIDER ?? "mock";
const pollIntervalMs = parsePositiveInt(process.env.WATCHER_POLL_INTERVAL_MS, 2000);
const acceptedTypes: AiJobType[] = [
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "crunch_knowledge_base"
];

let shuttingDown = false;

// The job currently claimed by this watcher, and the CLI child (if any) running
// it. On a shutdown signal we kill the child and best-effort release the job so
// it isn't left dangling in the "claimed/running" state.
let activeJob: AiJob | undefined;
let activeChild: ChildProcess | undefined;
let shutdownStarted = false;

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

async function shutdown(signal: string): Promise<void> {
  // Guard against a second signal re-entering while the first is still tearing
  // down (and against the loop racing the handler).
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  if (activeChild && activeChild.exitCode === null && !activeChild.killed) {
    activeChild.kill("SIGTERM");
  }

  const job = activeJob;
  if (job) {
    try {
      await postJson(`/ai-jobs/${job.id}/fail`, {
        error: `Watcher '${watcherName}' shut down (${signal}) before completing the job`
      });
      console.log(`Released claimed job ${job.id} on shutdown`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Failed to release job ${job.id} on shutdown: ${message}`);
    }
  }

  console.log(`Markdown Magpie watcher '${watcherName}' stopped`);
  process.exit(0);
}

async function poll(): Promise<void> {
  while (!shuttingDown) {
    try {
      const job = await claimNextJob();
      if (!job) {
        await sleep(pollIntervalMs);
        continue;
      }

      console.log(`Claimed ${job.type} job ${job.id}`);
      activeJob = job;
      try {
        await runAndComplete(job);
      } finally {
        // The job has now reached a terminal state (completed or failed) via
        // runAndComplete, so it no longer needs releasing on shutdown.
        activeJob = undefined;
      }
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
    const runner = createRunner(providerForJob(job));
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
  if (name === "openai-compatible") {
    return new OpenAICompatibleAgentRunner({
      apiKey: requiredEnv("OPENAI_COMPATIBLE_API_KEY"),
      baseUrl: requiredEnv("OPENAI_COMPATIBLE_BASE_URL"),
      model: requiredEnv("OPENAI_COMPATIBLE_MODEL")
    });
  }

  if (name === "codex") {
    return new CliAgentRunner({
      name: "codex",
      command: process.env.CODEX_CLI_PATH ?? "codex",
      args: splitArgs(process.env.CODEX_CLI_ARGS ?? "exec"),
      promptMode: normalizePromptMode(process.env.CODEX_CLI_PROMPT_MODE)
    });
  }

  if (name === "claude") {
    return new CliAgentRunner({
      name: "claude",
      command: process.env.CLAUDE_CLI_PATH ?? "claude",
      args: splitArgs(process.env.CLAUDE_CLI_ARGS ?? "-p"),
      promptMode: normalizePromptMode(process.env.CLAUDE_CLI_PROMPT_MODE)
    });
  }

  return new MockAgentRunner();
}

interface OpenAICompatibleAgentRunnerOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

class OpenAICompatibleAgentRunner implements AgentRunner {
  readonly name = "openai-compatible";
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAICompatibleAgentRunnerOptions) {
    this.timeoutMs = parsePositiveInt(process.env.AGENT_API_TIMEOUT_MS, 120000);
  }

  supports() {
    return true;
  }

  async run(job: AiJob): Promise<unknown> {
    const prompt = buildPrompt(job);
    const content = await withTimeout(
      this.complete(prompt),
      this.timeoutMs,
      `OpenAI-compatible provider timed out after ${this.timeoutMs}ms`
    );

    return parseJobOutput(job, content);
  }

  private async complete(prompt: string): Promise<string> {
    const response = await fetch(`${trimTrailingSlash(this.options.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          {
            role: "system",
            content: JOB_RUNNER_SYSTEM.instructions
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI-compatible provider failed with ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("OpenAI-compatible provider returned no message content");
    }

    return content;
  }
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

    if (job.type === "crunch_knowledge_base") {
      return this.crunchKnowledgeBase(job.input as CrunchKnowledgeBaseJobInput);
    }

    return {
      provider: this.name,
      status: "not_enough_signal",
      summary: `Mock runner received ${job.type}, but no specialist handler exists yet.`
    };
  }

  private crunchKnowledgeBase(input: CrunchKnowledgeBaseJobInput): CrunchKnowledgeBaseJobOutput {
    return buildMockCrunchPlan(input.documents ?? []);
  }

  // TODO(Task 7): the job input no longer carries pre-retrieved context. The real
  // watcher will route the question to a flow and call POST /api/retrieve to get
  // the sections to cite. Until that lands, the mock answerer has no source
  // material and reports a gap.
  private answerQuestion(input: AnswerQuestionJobInput): AnswerQuestionJobOutput {
    return {
      answer: "I could not find reliable source material for this question.",
      confidence: "low",
      citations: [],
      gaps: [
        {
          summary: `No source material found for: ${input.question}`,
          question: input.question,
          confidence: "low",
          citedSectionIds: []
        }
      ]
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
    const title = input.gapSummaries[0] ?? "Knowledge gap proposal";
    const gapList = input.gapSummaries.map((summary) => `- ${summary}`).join("\n");
    return {
      // The destination's docs folder is owned by the API at persist time; the
      // watcher only supplies the canonical filename.
      title,
      targetPath: resolveProposalTargetPath(undefined, title),
      markdown: `---\ntitle: ${title}\nstatus: draft\n---\n\n# ${title}\n\nThis proposal addresses the following gaps:\n\n${gapList}\n\nTODO: Review and expand this proposed article.\n`,
      rationale: `Mock proposal generated from ${input.gapSummaries.length} gap(s) and ${input.triggeringQuestions.length} triggering question(s).`
    };
  }
}

type PromptMode = "arg" | "stdin";

interface CliAgentRunnerOptions {
  name: string;
  command: string;
  args: string[];
  promptMode: PromptMode;
}

class CliAgentRunner implements AgentRunner {
  readonly name: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly promptMode: PromptMode;
  private readonly timeoutMs: number;

  constructor(options: CliAgentRunnerOptions) {
    this.name = options.name;
    this.command = options.command;
    this.args = options.args;
    this.promptMode = options.promptMode;
    this.timeoutMs = parsePositiveInt(process.env.AGENT_CLI_TIMEOUT_MS, 120000);
  }

  supports() {
    return true;
  }

  async run(job: AiJob): Promise<unknown> {
    const prompt = buildPrompt(job);
    const stdout = await runCli({
      command: this.command,
      args: this.promptMode === "arg" ? [...this.args, prompt] : this.args,
      stdin: this.promptMode === "stdin" ? prompt : undefined,
      timeoutMs: this.timeoutMs
    });

    return parseJobOutput(job, stdout);
  }
}

console.log(`Markdown Magpie watcher '${watcherName}' starting`);
console.log(`API: ${apiBaseUrl}`);
console.log(`Default provider: ${defaultProvider}`);
console.log(`Poll interval: ${pollIntervalMs}ms`);
console.log(`Accepted jobs: ${acceptedTypes.join(", ")}`);
logProviderReadiness(defaultProvider);

void poll();

// Surface whether the default provider's credentials/CLIs are present at
// startup, so a misconfigured provider is visible here rather than only when
// the first job fails. Secrets are reported as set/MISSING, never printed.
function logProviderReadiness(provider: string): void {
  const state = (name: string) => (process.env[name] ? "set" : "MISSING");
  if (provider === "openai-compatible") {
    console.log(
      `Provider readiness (openai-compatible) — base url: ${state("OPENAI_COMPATIBLE_BASE_URL")}, ` +
        `model: ${state("OPENAI_COMPATIBLE_MODEL")}, api key: ${state("OPENAI_COMPATIBLE_API_KEY")}`
    );
  } else if (provider === "codex") {
    console.log(
      `Provider readiness (codex) — command: ${process.env.CODEX_CLI_PATH ?? "codex"}, args: ${process.env.CODEX_CLI_ARGS ?? "exec"}`
    );
  } else if (provider === "claude") {
    console.log(
      `Provider readiness (claude) — command: ${process.env.CLAUDE_CLI_PATH ?? "claude"}, args: ${process.env.CLAUDE_CLI_ARGS ?? "-p"}`
    );
  } else if (provider === "mock") {
    console.log("Provider readiness (mock) — no external credentials required");
  } else {
    console.log(`Provider readiness — no check available for provider '${provider}'`);
  }
}

function providerForJob(job: AiJob): string {
  const provider = (job.input as { provider?: unknown }).provider;
  return typeof provider === "string" ? provider : defaultProvider;
}

async function postJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
  const response = await fetch(apiUrl(path), {
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

// Parse a positive integer from an env var, falling back to the default when
// the value is absent, malformed (NaN), or non-positive. Without this guard a
// bad value would yield NaN and make setTimeout/withTimeout busy-loop or reject
// instantly. (Mirrors @magpie/mcp's parsePositiveInt; not imported to avoid a
// cross-app dependency.)
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitArgs(value: string): string[] {
  return value
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizePromptMode(value: string | undefined): PromptMode {
  return value === "stdin" ? "stdin" : "arg";
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function apiUrl(path: string): string {
  return path.startsWith("/api/") || path === "/api" ? `${apiBaseUrl}${path}` : `${apiBaseUrl}/api${path}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function runCli(options: {
  command: string;
  args: string[];
  stdin?: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    // Track the child so a shutdown signal can terminate it promptly.
    activeChild = child;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Agent CLI timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      activeChild = undefined;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      activeChild = undefined;
      if (code !== 0) {
        reject(new Error(`Agent CLI exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }

      resolve(Buffer.concat(stdout).toString("utf8"));
    });

    if (options.stdin) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}
