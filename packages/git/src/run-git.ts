import { GIT_ALLOW_PROTOCOL_VALUE } from "@magpie/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactCredentials } from "./credentials.js";
import { withGitRetry } from "./git-retry.js";

const execFileAsync = promisify(execFile);

export function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// A hung git subprocess (e.g. a credential prompt on a misconfigured remote) or
// a stalled GitHub connection would otherwise block indexing and the PR poller
// indefinitely; large diffs/clones could also blow past execFile's 1 MB default
// stdout buffer. These bounds are configurable for unusually large repos.
export const GIT_SUBPROCESS_TIMEOUT_MS = positiveIntFromEnv("GIT_TIMEOUT_MS", 120_000);
const GIT_SUBPROCESS_MAX_BUFFER = positiveIntFromEnv("GIT_MAX_BUFFER_BYTES", 64 * 1024 * 1024);

// A FIRST clone downloads the whole commit graph (and, without partial clone, every
// blob), so it can legitimately take far longer than any fetch. Bounding it by
// GIT_TIMEOUT_MS made a large first clone time out on every attempt, forever
// (IN41). It gets its own, much larger bound; incremental fetches stay on
// GIT_TIMEOUT_MS.
export const GIT_CLONE_TIMEOUT_MS = positiveIntFromEnv("GIT_CLONE_TIMEOUT_MS", 30 * 60_000);

export interface GitRunOptions {
  // Extra child environment (only ever the GIT_CONFIG_* auth header).
  env?: Partial<NodeJS.ProcessEnv>;
  // Aborting kills the git child (SIGTERM — git removes its own lock files on it)
  // and rejects with an aborted GitCommandError that is never retried.
  signal?: AbortSignal;
  // Per-call timeout override (the first clone uses GIT_CLONE_TIMEOUT_MS).
  timeoutMs?: number;
}

// A failed git subprocess. The message is built from git's argv and stderr and
// is credential-redacted (TM37); the raw execFile error is deliberately NOT kept
// as `cause`, because its `cmd`/`stderr` fields would carry the unredacted text
// into any logger that serialises error causes.
export class GitCommandError extends Error {
  readonly aborted: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | undefined;

  constructor(message: string, details: { aborted?: boolean; timedOut?: boolean; exitCode?: number }) {
    super(redactCredentials(message));
    this.name = "GitCommandError";
    this.aborted = details.aborted ?? false;
    this.timedOut = details.timedOut ?? false;
    this.exitCode = details.exitCode;
  }
}

function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason.message : String(reason ?? "aborted");
}

function toGitCommandError(error: unknown, args: string[], timeoutMs: number, signal?: AbortSignal): GitCommandError {
  const subcommand = args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? "command";
  if (signal?.aborted) {
    return new GitCommandError(`git ${subcommand} aborted: ${abortReason(signal)}`, { aborted: true });
  }
  if (!(error instanceof Error)) {
    return new GitCommandError("git command failed", {});
  }
  const killed = "killed" in error && error.killed === true;
  const exitCode = "code" in error && typeof error.code === "number" ? error.code : undefined;
  if (killed && exitCode === undefined) {
    return new GitCommandError(`git ${subcommand} timed out after ${timeoutMs}ms: ${error.message}`, {
      timedOut: true
    });
  }
  return new GitCommandError(error.message, exitCode === undefined ? {} : { exitCode });
}

export async function git(cwd: string, args: string[], options: GitRunOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? GIT_SUBPROCESS_TIMEOUT_MS;
  return withGitRetry(async () => {
    if (options.signal?.aborted) {
      throw toGitCommandError(undefined, args, timeoutMs, options.signal);
    }
    try {
      const result = await execFileAsync("git", args, {
        cwd,
        // GIT_ALLOW_PROTOCOL is set on EVERY git invocation as an in-git backstop
        // for #285: git itself refuses any transport outside the allowlist (notably
        // the `ext::` RCE helper), even for a lazy blob fetch on an already-cloned
        // repo. Placed after process.env so it wins over any operator value, and
        // before `env` (which only ever carries GIT_CONFIG_* auth, never this key).
        // GIT_TERMINAL_PROMPT=0 makes a missing credential fail fast instead of
        // hanging on a prompt until the timeout.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: GIT_ALLOW_PROTOCOL_VALUE,
          ...(options.env ?? {})
        },
        timeout: timeoutMs,
        maxBuffer: GIT_SUBPROCESS_MAX_BUFFER,
        ...(options.signal ? { signal: options.signal } : {})
      });
      return result.stdout;
    } catch (error) {
      throw toGitCommandError(error, args, timeoutMs, options.signal);
    }
  });
}

export async function tryGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<string> {
  try {
    return await git(cwd, args, options);
  } catch (error) {
    // An abort is the caller's instruction to stop, not "no output": never swallow it.
    if (error instanceof GitCommandError && error.aborted) {
      throw error;
    }
    return "";
  }
}
