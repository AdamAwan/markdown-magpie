import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { ChatProvider, ChatRequest, ChatResponse, SourceDescriptor } from "@magpie/core";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import type { WatcherApi } from "../http-client.js";
import { buildSourceGroundedPrompt, parseJobOutput } from "../job-prompts.js";
import { logger } from "../logger.js";
import { hasFsSources, prepareSourceWorkspaces, sourceDescriptorsOf, type PreparedSources } from "../source-workspace.js";
import { PROVIDER_JOB_TYPES, runGenerativeJob } from "./generative.js";

export type PromptMode = "arg" | "stdin";

const DEFAULT_TIMEOUT_MS = 120_000;
// Source-grounded runs explore a checkout with the CLI's own tools — that takes
// minutes, not the seconds a one-shot completion needs.
const DEFAULT_AGENTIC_TIMEOUT_MS = 600_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;

// The slice of a spawned child process that spawnCli consumes. The real
// implementation is node's ChildProcess with fully piped stdio; tests substitute
// a scripted stand-in.
export interface SpawnedCli {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
}

// The exact (command, args, options) call shape spawnCli uses, matching that
// overload of node:child_process.spawn. The seam is narrowed to this shape
// (rather than `typeof spawn`) because a test fake cannot implement spawn's full
// overload set — every overload returns a concrete ChildProcess class — without
// unsafe casts.
export type CliSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; cwd?: string }
) => SpawnedCli;

export interface CliRunnerOptions {
  capability: Extract<JobCapability, "codex" | "claude">;
  command: string;
  args: string[];
  promptMode: PromptMode;
  // Optional model name. When set, `--model <model>` is appended to the CLI args
  // (the flag `claude` and `codex` share) so the agent runs on a specific model.
  model?: string;
  api?: WatcherApi;
  timeoutMs?: number;
  // Timeout for source-grounded agentic runs (checkout exploration takes minutes,
  // not the 120s a one-shot completion needs).
  agenticTimeoutMs?: number;
  // Root of the shared checkout volume where source workspaces are resolved.
  checkoutRoot?: string;
  // How long to wait after SIGTERM before SIGKILL when aborting.
  cancelGraceMs?: number;
  // Test seam: override the prompt the CLI receives so stdout is deterministic.
  buildPromptOverride?: (job: JobView) => string;
  // Test seam: substitute workspace preparation (no real checkouts in tests).
  prepareWorkspaces?: typeof prepareSourceWorkspaces;
  // Test seam: capture/fake process spawning.
  spawnOverride?: CliSpawn;
}

// Runs generative jobs via an external CLI agent (codex / claude). The CLI is
// adapted to the same complete() contract hosted chat providers use, so route,
// retrieve, answer, and critic-confirm flows stay identical across providers.
export class CliRunner {
  readonly capability: Extract<JobCapability, "codex" | "claude">;
  private readonly command: string;
  private readonly args: string[];
  private readonly promptMode: PromptMode;
  private readonly model?: string;
  private readonly api?: WatcherApi;
  private readonly timeoutMs: number;
  private readonly agenticTimeoutMs: number;
  private readonly checkoutRoot: string;
  private readonly cancelGraceMs: number;
  private readonly buildPromptOverride?: (job: JobView) => string;
  private readonly prepareWorkspaces: typeof prepareSourceWorkspaces;
  private readonly spawnFn: CliSpawn;

  constructor(options: CliRunnerOptions) {
    this.capability = options.capability;
    this.command = options.command;
    this.args = options.args;
    this.promptMode = options.promptMode;
    this.model = options.model;
    this.api = options.api;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.agenticTimeoutMs = options.agenticTimeoutMs ?? DEFAULT_AGENTIC_TIMEOUT_MS;
    this.checkoutRoot = options.checkoutRoot ?? process.env.MAGPIE_CHECKOUT_ROOT ?? ".magpie/checkouts";
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.buildPromptOverride = options.buildPromptOverride;
    this.prepareWorkspaces = options.prepareWorkspaces ?? prepareSourceWorkspaces;
    this.spawnFn = options.spawnOverride ?? spawn;
  }

  supports(type: JobType): boolean {
    return PROVIDER_JOB_TYPES.has(type);
  }

  async run(job: JobView, signal: AbortSignal): Promise<unknown> {
    // Source-grounded jobs never go through the ChatProvider adapter — the CLI
    // itself is the whole agent, exploring the checkout with its native tools.
    const descriptors = sourceDescriptorsOf(job);
    if (hasFsSources(descriptors)) {
      return this.runSourceGrounded(job, descriptors, signal);
    }
    const model = this.modelFor(job);
    return runGenerativeJob({
      job,
      model,
      api: this.api ?? missingApi,
      signal,
      ...(this.buildPromptOverride ? { buildPromptOverride: this.buildPromptOverride } : {})
    });
  }

  private async runSourceGrounded(job: JobView, descriptors: SourceDescriptor[], signal: AbortSignal): Promise<unknown> {
    const prepared = await this.prepareWorkspaces(descriptors, { checkoutRoot: this.checkoutRoot });
    // prepareSourceWorkspaces throws when no fs source resolved, so a first
    // workspace always exists on this path.
    const primary = prepared.workspaces[0];
    if (!primary) {
      throw new Error("source-grounded run has no prepared workspace");
    }
    const prompt = buildSourceGroundedPrompt(job, prepared.workspaces, prepared.notes, "cli");
    logger.info(
      { jobId: job.id, jobType: job.type, command: this.command, workspaceCount: prepared.workspaces.length, cwd: primary.rootDir },
      `${job.type}[${job.id}]: running ${this.command} CLI read-only over ${prepared.workspaces.length} source workspace(s)`
    );
    const content = await this.spawnCli(prompt, signal, {
      cwd: primary.rootDir,
      extraArgs: this.readOnlyArgs(prepared),
      timeoutMs: this.agenticTimeoutMs
    });
    return parseJobOutput(job, content);
  }

  // Read-only enforcement is assembled HERE, per capability, so it cannot be
  // dropped by operator arg configuration (CODEX_CLI_ARGS / CLAUDE_CLI_ARGS).
  //
  // Verified spellings:
  // - claude (verified LIVE on claude v2.1.201, 2026-07-06): `--tools Read,Grep,Glob`
  //   hard-removes every other tool from the model's toolset. `--allowedTools` is
  //   NOT sufficient — it only pre-approves, and Bash still executed in a live
  //   test. `--disallowedTools Write,Edit,NotebookEdit,Bash` is defence in depth
  //   on top of --tools. Extra workspaces need a repeated `--add-dir <dir>` each.
  // - codex (verified from openai/codex source at 0.142.5, 2026-07-06 — NOT
  //   executed locally; flagged in the PR as needing a deploy-environment check):
  //   `--sandbox read-only` is the explicit spelling (the default, but
  //   ~/.codex/config.toml can override it, so pass it always).
  //   `--skip-git-repo-check` because codex exec refuses to run in a non-git
  //   directory and local-kind source workspaces need not be git repos. Read-only
  //   mode does not confine reads to cwd, so extra workspaces need no flags —
  //   they are listed in the prompt.
  private readOnlyArgs(prepared: PreparedSources): string[] {
    if (this.capability === "claude") {
      const extraDirs = prepared.workspaces.slice(1).flatMap((ws) => ["--add-dir", ws.rootDir]);
      return ["--tools", "Read,Grep,Glob", "--disallowedTools", "Write,Edit,NotebookEdit,Bash", ...extraDirs];
    }
    return ["--sandbox", "read-only", "--skip-git-repo-check"];
  }

  private modelFor(job: JobView): ChatProvider {
    return {
      complete: async (request: ChatRequest): Promise<ChatResponse> => {
        const prompt = renderCliPrompt(request);
        logger.debug({ jobId: job.id, jobType: job.type, command: this.command, promptMode: this.promptMode }, `${job.type}[${job.id}]: invoking ${this.command} CLI (${this.promptMode} mode)`);
        const content = await this.spawnCli(prompt, request.signal ?? new AbortController().signal);
        logger.debug({ jobId: job.id, jobType: job.type, command: this.command, outputLength: content.length }, `${job.type}[${job.id}]: ${this.command} CLI finished, ${content.length} char(s) of output`);
        return { content };
      }
    };
  }

  private spawnCli(prompt: string, signal: AbortSignal, opts?: { cwd?: string; extraArgs?: string[]; timeoutMs?: number }): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("CLI runner aborted before start"));
        return;
      }

      const extraArgs = opts?.extraArgs ?? [];
      // Extra args go AFTER `--model` (whose single value must not be swallowed
      // by a trailing variadic flag) and, for claude in arg mode, are terminated
      // with `--`: claude's `--tools`/`--add-dir` are variadic and would swallow
      // a positional prompt without it. Structural here — not left to the extra
      // args' builder — so the extras can never detach from the prompt.
      const terminator = this.capability === "claude" && this.promptMode === "arg" && extraArgs.length > 0 ? ["--"] : [];
      const modelArgs = this.model ? ["--model", this.model] : [];
      const baseArgs = [...this.args, ...modelArgs, ...extraArgs, ...terminator];
      const args = this.promptMode === "arg" ? [...baseArgs, prompt] : baseArgs;
      const spawnOptions: { stdio: ["pipe", "pipe", "pipe"]; cwd?: string } = { stdio: ["pipe", "pipe", "pipe"] };
      if (opts?.cwd !== undefined) {
        spawnOptions.cwd = opts.cwd;
      }
      const child = this.spawnFn(this.command, args, spawnOptions);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let forceKillTimer: NodeJS.Timeout | undefined;

      const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Agent CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

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
  // Routing must never fail the ask, so even the no-op fallback abstains (deferring
  // to the chat router) rather than throwing.
  routeByEmbedding: async () => ({ status: "abstain" }),
  proposalExecutionContext: async () => {
    throw new Error("CLI runner requires a WatcherApi to fetch proposal execution context");
  },
  reconcileGaps: async () => ({ ok: true }),
  verifyClosure: async () => ({ proposalId: "p", closureStatus: "verified_closed", perQuestion: [] }),
  runSourceSync: async () => ({ runIds: [] }),
  runFixPatrol: async () => ({ runId: "", selectedCount: 0, findingCount: 0 }),
  runImprovePatrol: async () => ({ runId: "", selectedCount: 0, enqueuedCount: 0 }),
  listOpenPullRequests: async () => [],
  getSourceCorpus: async () => {
    throw new Error("CLI runner requires a WatcherApi to resolve a job's source corpus");
  }
};
