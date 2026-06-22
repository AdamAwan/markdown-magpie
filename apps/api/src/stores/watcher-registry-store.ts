import type { WatcherStatus, WatcherView } from "@magpie/core";
import type { JobCapability } from "@magpie/jobs";

// A single watcher liveness update. `capabilities` is only known when the watcher
// claims (the heartbeat/complete/fail calls don't carry it), so it is optional and
// left unchanged on an upsert that omits it. `currentJobId` is set while busy and
// cleared while idle.
export interface WatcherTouch {
  name: string;
  status: WatcherStatus;
  currentJobId?: string;
  capabilities?: JobCapability[];
}

export interface WatcherRegistryStore {
  // Records that a watcher is alive in the given status. Best-effort liveness:
  // callers swallow failures so a registry hiccup never breaks job lifecycle.
  touch(input: WatcherTouch): Promise<void>;
  // The watchers seen within the active window, most-recently-seen first. Rows
  // older than the window are pruned and excluded so a crashed watcher drops off.
  list(activeWithinMs: number): Promise<WatcherView[]>;
  reset(): Promise<void>;
}

interface WatcherRecord {
  status: WatcherStatus;
  capabilities: string[];
  currentJobId?: string;
  lastSeenAtMs: number;
}

// Test/default in-memory registry. Mirrors the Postgres store's upsert semantics:
// capabilities are kept when an update omits them, and the job id tracks busy/idle.
export class InMemoryWatcherRegistryStore implements WatcherRegistryStore {
  private readonly watchers = new Map<string, WatcherRecord>();

  async touch(input: WatcherTouch): Promise<void> {
    const existing = this.watchers.get(input.name);
    this.watchers.set(input.name, {
      status: input.status,
      capabilities: input.capabilities ?? existing?.capabilities ?? [],
      currentJobId: input.status === "busy" ? input.currentJobId : undefined,
      lastSeenAtMs: Date.now()
    });
  }

  async list(activeWithinMs: number): Promise<WatcherView[]> {
    const cutoff = Date.now() - activeWithinMs;
    for (const [name, record] of this.watchers) {
      if (record.lastSeenAtMs < cutoff) {
        this.watchers.delete(name);
      }
    }
    return [...this.watchers.entries()]
      .sort(([, left], [, right]) => right.lastSeenAtMs - left.lastSeenAtMs)
      .map(([name, record]) => ({
        name,
        status: record.status,
        capabilities: record.capabilities,
        ...(record.currentJobId ? { currentJobId: record.currentJobId } : {}),
        lastSeenAt: new Date(record.lastSeenAtMs).toISOString()
      }));
  }

  async reset(): Promise<void> {
    this.watchers.clear();
  }
}
