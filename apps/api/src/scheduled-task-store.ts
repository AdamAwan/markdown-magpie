import type { ScheduledTaskSettings } from "@magpie/core";
import { nextRunFor } from "./crunch-store.js";

// Persists the schedule for generic background side-processes. The task *registry*
// (label, description, default cron, handler) lives in the API host; this store
// only holds the per-task enabled/cron/last/next state.
export interface ScheduledTaskStore {
  listSettings(): Promise<ScheduledTaskSettings[]>;
  getSettings(key: string): Promise<ScheduledTaskSettings | undefined>;
  updateSettings(key: string, patch: { enabled: boolean; cron: string }): Promise<ScheduledTaskSettings>;
  touchSchedule(key: string, lastRunAt: string, nextRunAt: string): Promise<ScheduledTaskSettings | undefined>;
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

  async touchSchedule(key: string, lastRunAt: string, nextRunAt: string): Promise<ScheduledTaskSettings | undefined> {
    const current = this.settings.get(key);
    if (!current) {
      return undefined;
    }
    const next: ScheduledTaskSettings = { ...current, lastRunAt, nextRunAt };
    this.settings.set(key, next);
    return next;
  }

  async reset(): Promise<void> {
    this.settings.clear();
  }
}
