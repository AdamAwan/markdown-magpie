import { randomUUID } from "node:crypto";
import type { CrunchPlan, CrunchRun, CrunchRunTrigger, CrunchSettings, ProposalPublication } from "@magpie/core";
import { nextCronTime } from "@magpie/core";

// Daily at 02:00 local time.
export const DEFAULT_CRUNCH_CRON = "0 2 * * *";

export interface CrunchRunInput {
  flowId?: string;
  destinationId?: string;
  trigger: CrunchRunTrigger;
  documentCount: number;
  jobId?: string;
  // Direct-mode runs arrive already planned; queued runs start as "running".
  status: CrunchRun["status"];
  plan?: CrunchPlan;
  error?: string;
}

export interface CrunchStore {
  createRun(input: CrunchRunInput): Promise<CrunchRun>;
  listRuns(limit: number): Promise<CrunchRun[]>;
  getRun(id: string): Promise<CrunchRun | undefined>;
  getRunByJobId(jobId: string): Promise<CrunchRun | undefined>;
  completeRun(id: string, plan: CrunchPlan): Promise<CrunchRun | undefined>;
  failRun(id: string, error: string): Promise<CrunchRun | undefined>;
  recordRunPublication(id: string, publication: ProposalPublication): Promise<CrunchRun | undefined>;
  listSettings(): Promise<CrunchSettings[]>;
  getSettings(flowId: string | undefined): Promise<CrunchSettings>;
  updateSettings(flowId: string | undefined, patch: { enabled: boolean; cron: string }): Promise<CrunchSettings>;
  touchSchedule(flowId: string | undefined, lastRunAt: string, nextRunAt: string): Promise<CrunchSettings>;
  reset(): Promise<void>;
}

// A stable map key for the optional flow id, so the "default flow" (undefined)
// gets exactly one settings row.
function settingsKey(flowId: string | undefined): string {
  return flowId ?? "";
}

// The next scheduled run for an enabled cron, or undefined when disabled or the
// expression is invalid.
export function nextRunFor(enabled: boolean, cron: string, from: Date): string | undefined {
  if (!enabled) {
    return undefined;
  }
  return nextCronTime(cron, from)?.toISOString();
}

function defaultSettings(flowId: string | undefined): CrunchSettings {
  return {
    flowId,
    enabled: false,
    cron: DEFAULT_CRUNCH_CRON
  };
}

export class InMemoryCrunchStore implements CrunchStore {
  private readonly runs = new Map<string, CrunchRun>();
  private readonly settings = new Map<string, CrunchSettings>();

  async createRun(input: CrunchRunInput): Promise<CrunchRun> {
    const run: CrunchRun = {
      id: randomUUID(),
      flowId: input.flowId,
      destinationId: input.destinationId,
      trigger: input.trigger,
      status: input.status,
      jobId: input.jobId,
      plan: input.plan,
      error: input.error,
      documentCount: input.documentCount,
      createdAt: new Date().toISOString(),
      completedAt: input.status === "completed" || input.status === "failed" ? new Date().toISOString() : undefined
    };
    this.runs.set(run.id, run);
    return run;
  }

  async listRuns(limit: number): Promise<CrunchRun[]> {
    return [...this.runs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async getRun(id: string): Promise<CrunchRun | undefined> {
    return this.runs.get(id);
  }

  async getRunByJobId(jobId: string): Promise<CrunchRun | undefined> {
    // Match Postgres (ORDER BY created_at DESC): return the newest matching run.
    return [...this.runs.values()]
      .filter((run) => run.jobId === jobId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  async completeRun(id: string, plan: CrunchPlan): Promise<CrunchRun | undefined> {
    const existing = await this.getRun(id);
    if (existing?.status === "completed" || existing?.status === "published") return existing;
    return this.patchRun(id, { status: "completed", plan, completedAt: new Date().toISOString(), error: undefined });
  }

  async failRun(id: string, error: string): Promise<CrunchRun | undefined> {
    return this.patchRun(id, { status: "failed", error, completedAt: new Date().toISOString() });
  }

  async recordRunPublication(id: string, publication: ProposalPublication): Promise<CrunchRun | undefined> {
    return this.patchRun(id, { status: "published", publication });
  }

  private patchRun(id: string, patch: Partial<CrunchRun>): CrunchRun | undefined {
    const existing = this.runs.get(id);
    if (!existing) {
      return undefined;
    }
    const updated = { ...existing, ...patch };
    this.runs.set(id, updated);
    return updated;
  }

  async listSettings(): Promise<CrunchSettings[]> {
    return [...this.settings.values()];
  }

  async getSettings(flowId: string | undefined): Promise<CrunchSettings> {
    return this.settings.get(settingsKey(flowId)) ?? defaultSettings(flowId);
  }

  async updateSettings(
    flowId: string | undefined,
    patch: { enabled: boolean; cron: string }
  ): Promise<CrunchSettings> {
    const current = await this.getSettings(flowId);
    const next: CrunchSettings = {
      ...current,
      enabled: patch.enabled,
      cron: patch.cron,
      nextRunAt: nextRunFor(patch.enabled, patch.cron, new Date())
    };
    this.settings.set(settingsKey(flowId), next);
    return next;
  }

  async touchSchedule(flowId: string | undefined, lastRunAt: string, nextRunAt: string): Promise<CrunchSettings> {
    const current = await this.getSettings(flowId);
    const next: CrunchSettings = { ...current, lastRunAt, nextRunAt };
    this.settings.set(settingsKey(flowId), next);
    return next;
  }

  async reset(): Promise<void> {
    this.runs.clear();
    this.settings.clear();
  }
}
