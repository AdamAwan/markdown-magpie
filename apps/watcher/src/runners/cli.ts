import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { AiExecutionIdentity, ChatProvider, ChatRequest, ChatResponse, SourceDescriptor } from "@magpie/core";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import { JOB_RUNNER_SYSTEM } from "@magpie/prompts";
import type { WatcherApi } from "../http-client.js";
import { buildSourceGroundedPrompt, parseJobOutput } from "../job-prompts.js";
import { logger } from "../logger.js";
import {
  fetchSourceMapEntries,
  hasFsSources,
  prepareSourceWorkspaces,
  sourceDescriptorsOf,
  stampSourceMapUpdates,
  type PreparedSources
} from "../source-workspace.js";
import { PROVIDER_JOB_TYPES, runGenerativeJob } from "./generative.js";
import { runRepairReprompt } from "./repair.js";

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
  options: { stdio: ["pipe", "pipe", "pipe"]; cwd?: string; env?: NodeJS.ProcessEnv }
) => SpawnedCli;

// Environment allowlist for spawned agent CLIs (#290c). A child spawned with no
// `env` inherits the watcher's ENTIRE process.env — every provider key,
// GITHUB_TOKEN, DATABASE_URL, the M2M secret. codex's read-only sandbox still
// permits reading env/files, so a prompt-injected run could read those out; the
// claude path blocks Bash, but defense-in-depth says the child should never hold
// secrets it does not need in the first place. So each spawn passes an explicit
// minimal env: non-secret operational vars any process needs, plus only the
// calling CLI's own provider credential. Everything else is dropped.
//
// Name matching is case-insensitive so Windows' `Path`/`SystemRoot` casing and
// the lowercase `http_proxy` convention are both covered.

// Non-secret operational vars any spawned process legitimately needs. None is a
// credential — the watcher's secrets are deliberately absent from this list.
const BASE_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  // locale / formatting
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  // temp dirs
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  // POSIX identity some tools read to resolve config paths
  "USER",
  "LOGNAME",
  // Windows essentials — a spawned process (and node itself) needs these to run
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  // outbound proxy / custom CA — a networked CLI cannot reach its provider without these
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE"
];

// Each CLI's OWN provider credential(s). Deliberately exact names, NOT a prefix:
// `OPENAI_*` would sweep in OPENAI_COMPATIBLE_API_KEY (the chat runner's key — a
// different provider's secret). Enterprise auth paths (Bedrock/Vertex AWS or
// Google creds) and any nonstandard credential var are forwarded through
// MAGPIE_CLI_ENV_PASSTHROUGH rather than enumerated here.
const CREDENTIAL_ALLOWLIST: Record<"codex" | "claude", readonly string[]> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HEADERS",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CONFIG_DIR"
  ],
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORGANIZATION", "OPENAI_ORG_ID", "CODEX_HOME"]
};

// Operator escape hatch: extra var NAMES (comma/space separated) to forward to
// every CLI child — Bedrock/Vertex creds, a nonstandard credential var, extra
// proxy config — without a code change.
const ENV_PASSTHROUGH_VAR = "MAGPIE_CLI_ENV_PASSTHROUGH";

// Builds the minimal env a spawned CLI child receives, from `sourceEnv` (the
// watcher's process.env in production). Exported for direct unit testing.
export function buildChildEnv(capability: "codex" | "claude", sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extra = (sourceEnv[ENV_PASSTHROUGH_VAR] ?? "")
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  const allowed = new Set(
    [...BASE_ENV_ALLOWLIST, ...CREDENTIAL_ALLOWLIST[capability], ...extra].map((name) => name.toUpperCase())
  );
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (value !== undefined && allowed.has(name.toUpperCase())) {
      childEnv[name] = value;
    }
  }
  return childEnv;
}

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
  // Source env the spawned child's minimal allowlist is drawn from (#290c).
  // Defaults to the watcher's process.env; a test seam overrides it to assert the
  // allowlist without mutating global process state.
  spawnEnv?: NodeJS.ProcessEnv;
}

// Runs generative jobs via an external CLI agent (codex / claude). The CLI is
// adapted to the same complete() contract hosted chat providers use, so route,
// retrieve, answer, and critic-confirm flows stay identical across providers.
export class CliRunner {
  readonly capability: Extract<JobCapability, "codex" | "claude">;
  // Reported on every completion for cost attribution. `model` is only present
  // when explicitly configured — an unset model env means the CLI ran on its own
  // default, and reporting nothing beats guessing what the CLI resolved.
  readonly aiIdentity: AiExecutionIdentity;
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
  private readonly spawnEnv: NodeJS.ProcessEnv;

  constructor(options: CliRunnerOptions) {
    this.capability = options.capability;
    this.aiIdentity = { provider: options.capability, ...(options.model ? { model: options.model } : {}) };
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
    this.spawnEnv = options.spawnEnv ?? process.env;
  }

  supports(type: JobType): boolean {
    return PROVIDER_JOB_TYPES.has(type);
  }

  async run(job: JobView, signal: AbortSignal): Promise<unknown> {
    // Repair-reprompt (#288d): a re-claimed job carrying repair context runs a
    // single-shot reshape of its prior output through the CLI adapted to the same
    // complete() contract — no checkout, no agent loop. answer_question fans out
    // over all providers, so the CLI runners need this branch too.
    if (job.repair) {
      return runRepairReprompt({ job, model: this.modelFor(job), signal });
    }
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

  private async runSourceGrounded(
    job: JobView,
    descriptors: SourceDescriptor[],
    signal: AbortSignal
  ): Promise<unknown> {
    const prepared = await this.prepareWorkspaces(descriptors, { checkoutRoot: this.checkoutRoot });
    // prepareSourceWorkspaces throws when no fs source resolved, so a first
    // workspace always exists on this path.
    const primary = prepared.workspaces[0];
    if (!primary) {
      throw new Error("source-grounded run has no prepared workspace");
    }
    const mapEntries = await fetchSourceMapEntries(this.api, prepared.workspaces);
    // Fetchable internet sources (#242): claude gets a domain-allowlisted
    // WebFetch (see readOnlyArgs), so the prompt names them fetchable. codex
    // cannot fetch — its read-only OS sandbox blocks network — so for codex the
    // same sources degrade to the reference-only notes they always were.
    const fetchable = this.capability === "claude" ? prepared.fetchable : [];
    const notes =
      this.capability === "claude"
        ? prepared.notes
        : [
            ...prepared.notes,
            ...prepared.fetchable.map((source) =>
              source.url
                ? `Internet source "${source.name}": ${source.url} (reference only; not fetched).`
                : `Internet source "${source.name}": use relevant internet research as supporting material.`
            )
          ];
    const prompt = buildSourceGroundedPrompt(job, prepared.workspaces, notes, "cli", mapEntries, fetchable);
    // Neutral working directory (#280): the CLI must NOT run with its cwd set to
    // an untrusted source checkout. The MCP/settings flags in readOnlyArgs
    // neutralize a repo-committed `.mcp.json` / `.claude/settings.json`, but a
    // checkout-root memory file (`CLAUDE.md` for claude, `AGENTS.md` for codex)
    // is loaded from cwd as higher-trust project guidance and would steer the
    // run. Running from a neutral tmpdir removes that auto-load: the checkouts are
    // reached read-only as mounted directories (claude: a `--add-dir` each — added
    // dirs are tool-access roots, not memory/project roots; codex: read-only reads
    // aren't confined to cwd, and the prompt lists every workspace path) with no
    // source memory file at cwd for either CLI to treat as guidance.
    const neutralCwd = tmpdir();
    logger.info(
      {
        jobId: job.id,
        jobType: job.type,
        command: this.command,
        workspaceCount: prepared.workspaces.length,
        primaryWorkspace: primary.rootDir,
        cwd: neutralCwd
      },
      `${job.type}[${job.id}]: running ${this.command} CLI read-only over ${prepared.workspaces.length} source workspace(s)`
    );
    const content = await this.spawnCli(prompt, signal, {
      cwd: neutralCwd,
      extraArgs: this.readOnlyArgs(prepared),
      timeoutMs: this.agenticTimeoutMs
    });
    return stampSourceMapUpdates(parseJobOutput(job, content), prepared.workspaces);
  }

  // Read-only enforcement is assembled HERE, per capability, so it cannot be
  // dropped by operator arg configuration (CODEX_CLI_ARGS / CLAUDE_CLI_ARGS).
  //
  // Verified spellings:
  // - claude (verified LIVE on claude v2.1.201, 2026-07-06): `--tools Read,Grep,Glob`
  //   hard-removes every other tool from the model's toolset. `--allowedTools` is
  //   NOT sufficient — it only pre-approves, and Bash still executed in a live
  //   test. `--disallowedTools Write,Edit,NotebookEdit,Bash` is defence in depth
  //   on top of --tools. EVERY workspace (including the primary) is granted with a
  //   repeated `--add-dir <dir>` — the run's cwd is a neutral tmpdir (#280), not a
  //   checkout, so no source-repo CLAUDE.md loads as project memory.
  // - codex (spellings verified LIVE via `codex exec --help` on codex-cli 0.142.3,
  //   2026-07-06): `--sandbox read-only` is the explicit spelling (the default, but
  //   ~/.codex/config.toml can override it, so pass it always).
  //   `--skip-git-repo-check` because codex exec refuses to run in a non-git
  //   directory and the neutral tmpdir cwd (#280) is not a git repo. Read-only
  //   mode does not confine reads to cwd, so the workspaces need no flags —
  //   they are listed in the prompt. NOTE: codex read-only is enforced by an OS
  //   sandbox (Landlock/seatbelt); a deploy platform lacking it silently downgrades
  //   write protection — flagged in the PR as needing a deploy-environment check.
  private readOnlyArgs(prepared: PreparedSources): string[] {
    if (this.capability === "claude") {
      // Every workspace is mounted via `--add-dir` (#280): the run's cwd is a
      // neutral tmpdir (see runSourceGrounded), so NO checkout — not even the
      // primary — is the working directory, and none of their root CLAUDE.md
      // files load as project memory. `--add-dir` grants the read-only tools
      // access to each checkout without treating it as a project/memory root.
      const workspaceDirs = prepared.workspaces.flatMap((ws) => ["--add-dir", ws.rootDir]);
      // Fetchable internet sources (#242): WebFetch joins the toolset only when
      // the operator allowlisted hosts, and each host becomes a
      // `WebFetch(domain:…)` permission rule. In print mode a tool call that no
      // rule pre-approves is DENIED (there is no interactive prompt to fall back
      // to), so these rules are the enforcement: fetches to allowlisted domains
      // proceed, everything else is refused. NOTE: rule spelling follows the
      // documented permission-rule format; not yet live-verified like the flags
      // below — flagged in the PR/issue for a live check before production use.
      const fetchHosts = [...new Set(prepared.fetchable.flatMap((source) => source.allowedHosts))];
      const fetchTool = fetchHosts.length > 0 ? ",WebFetch" : "";
      const fetchAllowRules =
        fetchHosts.length > 0 ? ["--allowedTools", ...fetchHosts.map((host) => `WebFetch(domain:${host})`)] : [];
      // --strict-mcp-config (with no --mcp-config) loads zero MCP servers: a
      // checkout may carry its own .mcp.json (this repo does — it would hand the
      // agent the KB's own kb_* tools), and the operator's user-scope servers
      // must not leak in either. --setting-sources "" skips user/project
      // settings entirely, so a source repo's committed .claude/settings.json
      // (hooks — arbitrary command execution) is inert. Both verified live on
      // claude v2.1.x, 2026-07-13. --system-prompt makes the job-runner
      // instructions THE system prompt (#280): the source-grounded path had no
      // system prompt before, so the CLI booted with its own interactive persona
      // as the top-level instruction; replacing it with the job-runner system
      // message (which carries the untrusted-content contract) is the same
      // hardening the one-shot generative path already applies.
      return [
        "--tools",
        `Read,Grep,Glob${fetchTool}`,
        "--disallowedTools",
        "Write,Edit,NotebookEdit,Bash",
        ...fetchAllowRules,
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--system-prompt",
        JOB_RUNNER_SYSTEM.instructions,
        ...workspaceDirs
      ];
    }
    // codex has no --system-prompt flag; its source-grounded prompt keeps the
    // task instructions (which carry the untrusted-content contract). The neutral
    // tmpdir cwd (see runSourceGrounded) is what neutralizes a checkout-root
    // AGENTS.md here — read-only reads aren't confined to cwd, so codex still
    // reaches every workspace path listed in the prompt.
    return ["--sandbox", "read-only", "--skip-git-repo-check"];
  }

  // Isolation for one-shot generative runs, assembled HERE per capability for the
  // same reason as readOnlyArgs: operator arg config can't drop it. A generative
  // job is a completion — the CLI must behave like a completion endpoint, not
  // like the interactive assistant it boots as by default. Without this, a
  // `claude -p` run carries the full interactive toolset and persona; when a
  // prompt tempted it to "look something up" it answered with a plea to grant it
  // tool permissions, and that chatter shipped as the job output.
  //
  // Verified spellings (claude v2.1.x, live 2026-07-13):
  // - `--tools ""` empties the built-in toolset (nothing to reach for, nothing to
  //   ask the "user" to grant).
  // - `--strict-mcp-config` with no --mcp-config loads zero MCP servers.
  // - `--setting-sources ""` skips user/project settings (hooks, permission
  //   grants, plugins/skills).
  // - `--system-prompt` makes the job-runner instructions THE system prompt.
  //   renderCliPrompt's folded "SYSTEM:" block is user-level text that competes
  //   with (and loses to) the CLI's own persona; this flag replaces that persona.
  // codex (spellings shared with readOnlyArgs, verified on codex-cli 0.142.x):
  // `--sandbox read-only` (config.toml can override the default, so pass it
  // always) and `--skip-git-repo-check` (the neutral cwd is not a git repo).
  // codex exec has no system-prompt flag, so its prompt keeps the folded block.
  private generativeIsolationArgs(system: string): string[] {
    if (this.capability === "claude") {
      return ["--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", system];
    }
    return ["--sandbox", "read-only", "--skip-git-repo-check"];
  }

  private modelFor(job: JobView): ChatProvider {
    return {
      complete: async (request: ChatRequest): Promise<ChatResponse> => {
        // claude carries the system prompt on --system-prompt, so its positional
        // prompt is the messages alone; codex keeps the folded SYSTEM: block.
        const prompt = this.capability === "claude" ? renderCliMessages(request) : renderCliPrompt(request);
        logger.debug(
          { jobId: job.id, jobType: job.type, command: this.command, promptMode: this.promptMode },
          `${job.type}[${job.id}]: invoking ${this.command} CLI (${this.promptMode} mode)`
        );
        const content = await this.spawnCli(prompt, request.signal ?? new AbortController().signal, {
          // Neutral cwd: the watcher's own cwd is a Claude Code project in dev
          // (this repo), whose CLAUDE.md / .mcp.json / .claude settings would
          // otherwise load into the completion's context.
          cwd: tmpdir(),
          extraArgs: this.generativeIsolationArgs(request.system)
        });
        logger.debug(
          { jobId: job.id, jobType: job.type, command: this.command, outputLength: content.length },
          `${job.type}[${job.id}]: ${this.command} CLI finished, ${content.length} char(s) of output`
        );
        return { content };
      }
    };
  }

  private spawnCli(
    prompt: string,
    signal: AbortSignal,
    opts?: { cwd?: string; extraArgs?: string[]; timeoutMs?: number }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("CLI runner aborted before start"));
        return;
      }

      const extraArgs = opts?.extraArgs ?? [];
      // Extra args go AFTER `--model` (whose single value must not be swallowed
      // by a trailing variadic flag) and, in arg mode, are terminated with `--`
      // before the positional prompt. claude's `--tools`/`--add-dir` are variadic
      // and would swallow the prompt without it; codex's prompt is a bare clap
      // positional that a leading `-`/`--` in the prompt text would misparse as a
      // flag — `--` (honoured by clap) forecloses both. Structural here — not left
      // to the extra args' builder — so the extras can never detach from the
      // prompt. Every spawn passes extraArgs now (readOnlyArgs on the
      // source-grounded path, generativeIsolationArgs on the one-shot path).
      const terminator = this.promptMode === "arg" && extraArgs.length > 0 ? ["--"] : [];
      const modelArgs = this.model ? ["--model", this.model] : [];
      const baseArgs = [...this.args, ...modelArgs, ...extraArgs, ...terminator];
      const args = this.promptMode === "arg" ? [...baseArgs, prompt] : baseArgs;
      // Minimal env allowlist (#290c): the child never inherits the watcher's
      // full process.env — only non-secret operational vars and this CLI's own
      // provider credential.
      const spawnOptions: { stdio: ["pipe", "pipe", "pipe"]; cwd?: string; env: NodeJS.ProcessEnv } = {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv(this.capability, this.spawnEnv)
      };
      if (opts?.cwd !== undefined) {
        spawnOptions.cwd = opts.cwd;
      }
      const child = this.spawnFn(this.command, args, spawnOptions);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let forceKillTimer: NodeJS.Timeout | undefined;

      const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
      const timeout = setTimeout(() => {
        // Escalate exactly as the abort path does: a hung agent that ignores
        // SIGTERM (or whose exit stalls) is force-killed after the grace window
        // rather than left orphaned consuming API tokens until the host reaps it.
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), this.cancelGraceMs);
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
  return `SYSTEM:\n${request.system}\n\n${renderCliMessages(request)}`;
}

function renderCliMessages(request: ChatRequest): string {
  return request.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
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
  runSeedBootstrap: async () => ({ enqueued: false, reason: "no_sources" }),
  listOpenPullRequests: async () => [],
  sourceMapEntries: async () => []
};
