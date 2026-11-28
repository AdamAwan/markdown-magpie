import { randomUUID } from "node:crypto";
import type { MaintenanceRun, MaintenanceTaskType, NewMaintenanceRun } from "@magpie/core";

// What a `running` run's later progress may change: its outcome, never its
// identity (task, flow, trigger, start).
export type MaintenanceRunUpdate = Pick<MaintenanceRun, "status" | "summary" | "details">;

// One durable record per scheduled-task execution (see core MaintenanceRun). The
// store is deliberately thin: tasks `record()` a run, and the console `list()`s
// them newest-first. Most writers are atomic (one terminal record). A task whose
// work finishes after the tick returns — the correctness patrol, whose verifies
// complete asynchronously — records the run `running` and `update()`s it as its
// follow-up jobs settle.
export interface MaintenanceRunStore {
  record(input: NewMaintenanceRun): Promise<MaintenanceRun>;
  // Rewrites a run's outcome. completedAt follows the status: stamped when the
  // run leaves `running`, cleared if it is `running` again. Returns undefined for
  // an unknown id.
  update(id: string, update: MaintenanceRunUpdate): Promise<MaintenanceRun | undefined>;
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

  async update(id: string, update: MaintenanceRunUpdate): Promise<MaintenanceRun | undefined> {
    const index = this.runs.findIndex((run) => run.id === id);
    const existing = this.runs[index];
    if (!existing) {
      return undefined;
    }
    const updated: MaintenanceRun = {
      ...existing,
      ...update,
      completedAt: update.status === "running" ? undefined : new Date().toISOString()
    };
    this.runs[index] = updated;
    return updated;
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
