import { spawn } from "node:child_process";
import type { ChatProvider, ChatRequest, ChatResponse } from "@magpie/core";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import type { WatcherApi } from "../http-client.js";
import { PROVIDER_JOB_TYPES, runGenerativeJob } from "./generative.js";

export type PromptMode = "arg" | "stdin";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;

export interface CliRunnerOptions {
  capability: Extract<JobCapability, "codex" | "claude">;
  command: string;
  args: string[];
  promptMode: PromptMode;
  api?: WatcherApi;
  timeoutMs?: number;
  // How long to wait after SIGTERM before SIGKILL when aborting.
  cancelGraceMs?: number;
  // Test seam: override the prompt the CLI receives so stdout is deterministic.
  buildPromptOverride?: (job: JobView) => string;
}

// Runs generative jobs via an external CLI agent (codex / claude). The CLI is
// adapted to the same complete() contract hosted chat providers use, so route,
// retrieve, answer, and critic-confirm flows stay identical across providers.
export class CliRunner {
  readonly capability: Extract<JobCapability, "codex" | "claude">;
  private readonly command: string;
  private readonly args: string[];
  private readonly promptMode: PromptMode;
  private readonly api?: WatcherApi;
  private readonly timeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly buildPromptOverride?: (job: JobView) => string;

  constructor(options: CliRunnerOptions) {
    this.capability = options.capability;
    this.command = options.command;
    this.args = options.args;
    this.promptMode = options.promptMode;
    this.api = options.api;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.buildPromptOverride = options.buildPromptOverride;
  }

  supports(type: JobType): boolean {
    return PROVIDER_JOB_TYPES.has(type);
  }

  async run(job: JobView, signal: AbortSignal): Promise<unknown> {
    const model = this.modelFor(job);
    return runGenerativeJob({
      job,
      model,
      api: this.api ?? missingApi,
      signal,
      ...(this.buildPromptOverride ? { buildPromptOverride: this.buildPromptOverride } : {})
    });
  }

  private modelFor(job: JobView): ChatProvider {
    return {
      complete: async (request: ChatRequest): Promise<ChatResponse> => {
        const prompt = renderCliPrompt(request);
        console.log(`${job.type}[${job.id}]: invoking ${this.command} CLI (${this.promptMode} mode)`);
        const content = await this.spawnCli(prompt, request.signal ?? new AbortController().signal);
        console.log(`${job.type}[${job.id}]: ${this.command} CLI finished, ${content.length} char(s) of output`);
        return { content };
      }
    };
  }

  private spawnCli(prompt: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("CLI runner aborted before start"));
        return;
      }

      const args = this.promptMode === "arg" ? [...this.args, prompt] : this.args;
      const child = spawn(this.command, args, { stdio: ["pipe", "pipe", "pipe"] });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let forceKillTimer: NodeJS.Timeout | undefined;

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Agent CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      // On abort: graceful SIGTERM, then SIGKILL after the grace window.
      const onAbort = (): void => {
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), this.cancelGraceMs);
        reject(new Error("CLI runner aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timeout);
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        signal.removeEventListener("abort", onAbort);
      };

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.on("close", (code) => {
        cleanup();
        if (code !== 0) {
          reject(new Error(`Agent CLI exited with ${code}: ${Buffer.concat(stderrChunks).toString("utf8")}`));
          return;
        }
        resolve(Buffer.concat(stdoutChunks).toString("utf8"));
      });

      if (this.promptMode === "stdin") {
        child.stdin.end(prompt);
      } else {
        child.stdin.end();
      }
    });
  }
}

function renderCliPrompt(request: ChatRequest): string {
  const messages = request.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
  return `SYSTEM:\n${request.system}\n\n${messages}`;
}

const missingApi: WatcherApi = {
  claim: async () => undefined,
  heartbeat: async () => ({ cancelled: false }),
  complete: async () => undefined,
  fail: async () => undefined,
  retrieve: async () => {
    throw new Error("CLI runner requires a WatcherApi to run answer_question");
  },
  proposalExecutionContext: async () => {
    throw new Error("CLI runner requires a WatcherApi to fetch proposal execution context");
  },
  reconcileGaps: async () => ({ ok: true }),
  runSourceSync: async () => ({ runIds: [] }),
  runFixPatrol: async () => ({ runId: "", selectedCount: 0, findingCount: 0 }),
  runImprovePatrol: async () => ({ runId: "", selectedCount: 0, enqueuedCount: 0 }),
  listOpenPullRequests: async () => []
};
