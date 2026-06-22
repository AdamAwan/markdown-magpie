import type { ScheduledTaskSettings } from "@magpie/core";

// Persists the schedule for generic background side-processes. The task *registry*
// (label, description, default cron, handler) lives in the API host; this store
// only holds the per-task enabled/cron state. Run timing and overlap protection
// are owned by pg-boss now, not tracked here.
export interface ScheduledTaskStore {
  listSettings(): Promise<ScheduledTaskSettings[]>;
  getSettings(key: string): Promise<ScheduledTaskSettings | undefined>;
  updateSettings(key: string, patch: { enabled: boolean; cron: string }): Promise<ScheduledTaskSettings>;
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
      cron: patch.cron
    };
    this.settings.set(key, next);
    return next;
  }

  async reset(): Promise<void> {
    this.settings.clear();
  }
}
