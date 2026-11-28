import { spawn } from "node:child_process";

// Process-tree and output bounds for spawned agent CLIs (docs/ai-jobs.md J85).
//
// An agent CLI is not one process: claude and codex start helpers (MCP/tool
// subprocesses, a sandbox wrapper, a shell for a tool call). Killing only the
// direct child on timeout or cancellation leaves those running — still holding
// the stdio pipes (so the runner never sees `close`) and, for an agent, still
// spending tokens. So on POSIX every CLI is spawned as its own process-group
// leader (`detached: true`) and killed as a group (`kill(-pid)`); on Windows,
// where there are no process groups or signals, the tree is terminated with
// `taskkill /T /F`.

// The minimal view of a spawned child these helpers need.
export interface KillableChild {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

// Spawn options that make the child killable as a tree: a new process group on
// POSIX; on Windows `detached` would open a new console, so it stays attached
// and the tree is found through taskkill's parent-pid walk instead.
export function processTreeSpawnOptions(platform: NodeJS.Platform = process.platform): {
  detached: boolean;
  windowsHide: boolean;
} {
  return { detached: platform !== "win32", windowsHide: true };
}

// Process groups this watcher started and has not yet seen exit. On watcher
// exit (crash, or a shutdown that did not get to abort the job) they are killed
// so a detached agent does not outlive the process that was supervising it.
const liveGroups = new Set<number>();
let exitHookInstalled = false;

export function trackProcessGroup(child: KillableChild, platform: NodeJS.Platform = process.platform): () => void {
  const pid = child.pid;
  if (platform === "win32" || pid === undefined) {
    return () => {};
  }
  liveGroups.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // `exit` handlers must be synchronous; process.kill is.
    process.on("exit", () => {
      for (const group of liveGroups) {
        signalGroup(group, "SIGKILL");
      }
    });
  }
  return () => {
    liveGroups.delete(pid);
  };
}

// Sends `signal` to the child's whole tree. Falls back to the direct child when
// there is no pid (the process failed to spawn, or a test stand-in).
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform
): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill(signal);
    return;
  }
  if (platform === "win32") {
    // No graceful signal exists for a console process tree on Windows: the
    // first kill already terminates it. The direct kill covers taskkill being
    // unavailable; taskkill /T reaches the descendants.
    child.kill(signal);
    const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    taskkill.on("error", () => undefined);
    return;
  }
  if (!signalGroup(pid, signal)) {
    child.kill(signal);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // ESRCH: the group is already gone. EPERM cannot happen for our own child.
    return false;
  }
}

// Collects a stream's chunks up to `maxBytes`. `push` returns false once the cap
// is crossed (the caller fails the run); the bytes kept never exceed the cap.
export class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private overflowed = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): boolean {
    if (this.overflowed) {
      return false;
    }
    const room = this.maxBytes - this.size;
    if (chunk.length > room) {
      if (room > 0) {
        this.chunks.push(chunk.subarray(0, room));
        this.size += room;
      }
      this.overflowed = true;
      return false;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    return true;
  }

  get exceeded(): boolean {
    return this.overflowed;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

// Keeps only the LAST `maxBytes` of a stream — for stderr, where the tail
// (the final error) is what a failure message needs, and an agent that logs
// verbosely must not be failed for it.
export class TailOutput {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maxBytes && this.chunks.length > 0) {
      const excess = this.size - this.maxBytes;
      const head = this.chunks[0];
      if (!head) {
        break;
      }
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
      this.dropped = true;
    }
  }

  text(): string {
    const body = Buffer.concat(this.chunks).toString("utf8");
    return this.dropped ? `…${body}` : body;
  }
}
