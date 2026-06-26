import { randomUUID } from "node:crypto";
import type { MaintenanceRun, MaintenanceTaskType, NewMaintenanceRun } from "@magpie/core";

// One durable record per scheduled-task execution (see core MaintenanceRun). The
// store is deliberately thin: tasks `record()` a terminal run, and the console
// `list()`s them newest-first. A `running` lifecycle (start/complete) is added when
// an async task needs it (source-sync, project B); project A writers are atomic.
export interface MaintenanceRunStore {
  record(input: NewMaintenanceRun): Promise<MaintenanceRun>;
  list(filters: { taskType?: MaintenanceTaskType; flowId?: string; limit: number }): Promise<MaintenanceRun[]>;
  get(id: string): Promise<MaintenanceRun | undefined>;
  reset(): Promise<void>;
}

export class InMemoryMaintenanceRunStore implements MaintenanceRunStore {
  // Insertion order is the audit order; list() reverses it for newest-first.
  private readonly runs: MaintenanceRun[] = [];

  async record(input: NewMaintenanceRun): Promise<MaintenanceRun> {
    const now = new Date().toISOString();
    const run: MaintenanceRun = {
      ...input,
      id: randomUUID(),
      startedAt: input.startedAt ?? now,
      // A terminal run completes at record time; a still-running one has no end yet.
      completedAt: input.completedAt ?? (input.status === "running" ? undefined : now)
    };
    this.runs.push(run);
    return run;
  }

  async list(filters: { taskType?: MaintenanceTaskType; flowId?: string; limit: number }): Promise<MaintenanceRun[]> {
    return [...this.runs]
      .reverse()
      .filter((run) => (filters.taskType ? run.taskType === filters.taskType : true))
      .filter((run) => (filters.flowId !== undefined ? run.flowId === filters.flowId : true))
      .slice(0, filters.limit);
  }

  async get(id: string): Promise<MaintenanceRun | undefined> {
    return this.runs.find((run) => run.id === id);
  }

  async reset(): Promise<void> {
    this.runs.length = 0;
  }
}
