import type { ScheduledTaskSettings } from "@magpie/core";
import { nextRunFor } from "./crunch-store.js";

// How long a held run-lock survives without being cleared before another runner
// may reclaim it. Guards against a crashed runner wedging the task forever;
// generous because a real reconcile is minutes, not an hour.
export function runLockStaleMs(): number {
  const raw = process.env.SCHEDULED_TASK_RUN_LOCK_STALE_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3_600_000;
}

// Persists the schedule for generic background side-processes. The task *registry*
// (label, description, default cron, handler) lives in the API host; this store
// only holds the per-task enabled/cron/last/next state.
export interface ScheduledTaskStore {
  listSettings(): Promise<ScheduledTaskSettings[]>;
  getSettings(key: string): Promise<ScheduledTaskSettings | undefined>;
  updateSettings(key: string, patch: { enabled: boolean; cron: string }): Promise<ScheduledTaskSettings>;
  // Advances a task's schedule. When `expectedNextRunAt` is supplied this is an
  // atomic claim: the update only applies if the row's next_run_at still equals
  // that value, so exactly one instance wins when several tick at once. Returns
  // undefined when the row is missing OR the claim was lost to another instance.
  touchSchedule(
    key: string,
    lastRunAt: string,
    nextRunAt: string,
    expectedNextRunAt?: string
  ): Promise<ScheduledTaskSettings | undefined>;
  // Atomically takes the run-lock for a task. Returns the settings when the lock
  // is taken, or undefined when a run is already in flight (so the caller skips
  // rather than starting an overlapping run). Creates the row from `defaultCron`
  // when the task has never been saved, so a "Run now" on an unscheduled task
  // still locks. A lock older than runLockStaleMs() is reclaimed.
  tryAcquireRun(key: string, defaultCron: string): Promise<ScheduledTaskSettings | undefined>;
  // Clears the run-lock once a run finishes (or fails). Idempotent.
  releaseRun(key: string): Promise<void>;
  reset(): Promise<void>;
}

export class InMemoryScheduledTaskStore implements ScheduledTaskStore {
  private readonly settings = new Map<string, ScheduledTaskSettings>();

  async listSettings(): Promise<ScheduledTaskSettings[]> {
    return [...this.settings.values()];
  }

  async getSettings(key: string): Promise<ScheduledTaskSettings | undefined> {
    return this.settings.get(key);
  }

  async updateSettings(key: string, patch: { enabled: boolean; cron: string }): Promise<ScheduledTaskSettings> {
    const next: ScheduledTaskSettings = {
      key,
      enabled: patch.enabled,
      cron: patch.cron,
      lastRunAt: this.settings.get(key)?.lastRunAt,
      nextRunAt: nextRunFor(patch.enabled, patch.cron, new Date())
    };
    this.settings.set(key, next);
    return next;
  }

  async touchSchedule(
    key: string,
    lastRunAt: string,
    nextRunAt: string,
    expectedNextRunAt?: string
  ): Promise<ScheduledTaskSettings | undefined> {
    const current = this.settings.get(key);
    if (!current) {
      return undefined;
    }
    // Atomic-claim semantics: bail if another claimant already advanced the row.
    if (expectedNextRunAt !== undefined && current.nextRunAt !== expectedNextRunAt) {
      return undefined;
    }
    const next: ScheduledTaskSettings = { ...current, lastRunAt, nextRunAt };
    this.settings.set(key, next);
    return next;
  }

  async tryAcquireRun(key: string, defaultCron: string): Promise<ScheduledTaskSettings | undefined> {
    const now = Date.now();
    const current = this.settings.get(key);
    if (!current) {
      const created: ScheduledTaskSettings = {
        key,
        enabled: false,
        cron: defaultCron,
        runningSince: new Date(now).toISOString()
      };
      this.settings.set(key, created);
      return created;
    }
    const heldSince = current.runningSince ? Date.parse(current.runningSince) : undefined;
    const held = heldSince !== undefined && now - heldSince < runLockStaleMs();
    if (held) {
      return undefined;
    }
    const acquired: ScheduledTaskSettings = { ...current, runningSince: new Date(now).toISOString() };
    this.settings.set(key, acquired);
    return acquired;
  }

  async releaseRun(key: string): Promise<void> {
    const current = this.settings.get(key);
    if (current) {
      this.settings.set(key, { ...current, runningSince: undefined });
    }
  }

  async reset(): Promise<void> {
    this.settings.clear();
  }
}
