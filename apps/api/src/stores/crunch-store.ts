import { randomUUID } from "node:crypto";
import type { MaintenancePlan, CrunchRun, CrunchRunTrigger, CrunchSettings, ProposalPublication } from "@magpie/core";

// Daily at 02:00 local time.
export const DEFAULT_CRUNCH_CRON = "0 2 * * *";

export interface CrunchRunInput {
  flowId?: string;
  destinationId?: string;
  trigger: CrunchRunTrigger;
  documentCount: number;
  jobId?: string;
  status: CrunchRun["status"];
  plan?: MaintenancePlan;
  error?: string;
}

export interface CrunchStore {
  createRun(input: CrunchRunInput): Promise<CrunchRun>;
  listRuns(limit: number): Promise<CrunchRun[]>;
  getRun(id: string): Promise<CrunchRun | undefined>;
  getRunByJobId(jobId: string): Promise<CrunchRun | undefined>;
  completeRun(id: string, plan: MaintenancePlan): Promise<CrunchRun | undefined>;
  failRun(id: string, error: string): Promise<CrunchRun | undefined>;
  recordRunPublication(id: string, publication: ProposalPublication): Promise<CrunchRun | undefined>;
  listSettings(): Promise<CrunchSettings[]>;
  getSettings(flowId: string | undefined): Promise<CrunchSettings>;
  updateSettings(flowId: string | undefined, patch: { enabled: boolean; cron: string }): Promise<CrunchSettings>;
  reset(): Promise<void>;
}

// A stable map key for the optional flow id, so the "default flow" (undefined)
// gets exactly one settings row.
function settingsKey(flowId: string | undefined): string {
  return flowId ?? "";
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

  async completeRun(id: string, plan: MaintenancePlan): Promise<CrunchRun | undefined> {
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
      cron: patch.cron
    };
    this.settings.set(settingsKey(flowId), next);
    return next;
  }

  async reset(): Promise<void> {
    this.runs.clear();
    this.settings.clear();
  }
}
