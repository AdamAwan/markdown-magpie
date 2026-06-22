import { spawn } from "node:child_process";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import { buildPrompt, parseJobOutput } from "../job-prompts.js";

export type PromptMode = "arg" | "stdin";

// The CLI AI job types. Same set as the chat runner minus answer_question, which
// requires the watcher's route/retrieve plumbing and so runs through the chat
// path only. A CLI provider executes the deterministic generative jobs.
const CLI_JOB_TYPES: ReadonlySet<JobType> = new Set([
  "summarize_gap",
  "draft_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "crunch_knowledge_base",
  "cluster_gap_candidates"
]);

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;

export interface CliRunnerOptions {
  capability: Extract<JobCapability, "codex" | "claude">;
  command: string;
  args: string[];
  promptMode: PromptMode;
  timeoutMs?: number;
  // How long to wait after SIGTERM before SIGKILL when aborting.
  cancelGraceMs?: number;
  // Test seam: override the prompt the CLI receives so stdout is deterministic.
  buildPromptOverride?: (job: JobView) => string;
}

// Runs a generative job via an external CLI agent (codex / claude), preserving
// the original watcher's prompt arg/stdin modes and timeout behaviour. On abort
// it sends SIGTERM, waits cancelGraceMs, then SIGKILL.
export class CliRunner {
  readonly capability: Extract<JobCapability, "codex" | "claude">;
  private readonly command: string;
  private readonly args: string[];
  private readonly promptMode: PromptMode;
  private readonly timeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly buildPromptOverride?: (job: JobView) => string;

  constructor(options: CliRunnerOptions) {
    this.capability = options.capability;
    this.command = options.command;
    this.args = options.args;
    this.promptMode = options.promptMode;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.buildPromptOverride = options.buildPromptOverride;
  }

  supports(type: JobType): boolean {
    return CLI_JOB_TYPES.has(type);
  }

  async run(job: JobView, signal: AbortSignal): Promise<unknown> {
    const prompt = this.buildPromptOverride ? this.buildPromptOverride(job) : buildPrompt(job);
    console.log(`${job.type}[${job.id}]: invoking ${this.command} CLI (${this.promptMode} mode)`);
    const stdout = await this.spawnCli(prompt, signal);
    console.log(`${job.type}[${job.id}]: ${this.command} CLI finished, ${stdout.length} char(s) of output`);
    return parseJobOutput(job, stdout);
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
