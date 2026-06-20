import { randomUUID } from "node:crypto";
import type { CrunchPlan, ProposalPublication, SourceSyncRun, SourceSyncState } from "@magpie/core";

export interface SourceSyncRunInput {
  flowId?: string;
  destinationId?: string;
  sourceId: string;
  trigger: SourceSyncRun["trigger"];
  status: SourceSyncRun["status"];
  jobId?: string;
  plan?: CrunchPlan;
  error?: string;
  fromSha?: string;
  toSha: string;
  changedFileCount: number;
  candidateCount: number;
}

// Persists what each flow/source has reacted to (the last processed commit) and a
// history of sync runs for the UI. The watch *behaviour* lives in the feature
// service; this store only holds state and run records.
export interface SourceSyncStore {
  getState(flowId: string | undefined, sourceId: string): Promise<SourceSyncState | undefined>;
  setState(flowId: string | undefined, sourceId: string, lastSha: string): Promise<SourceSyncState>;
  createRun(input: SourceSyncRunInput): Promise<SourceSyncRun>;
  listRuns(limit: number): Promise<SourceSyncRun[]>;
  getRun(id: string): Promise<SourceSyncRun | undefined>;
  recordRunPublication(id: string, publication: ProposalPublication): Promise<SourceSyncRun | undefined>;
  reset(): Promise<void>;
}

// A stable map key for the (optional flow id, source id) pair, so the default
// flow (undefined) gets exactly one state row per source.
function stateKey(flowId: string | undefined, sourceId: string): string {
  return `${flowId ?? ""}\0${sourceId}`;
}

export class InMemorySourceSyncStore implements SourceSyncStore {
  private readonly states = new Map<string, SourceSyncState>();
  private readonly runs = new Map<string, SourceSyncRun>();

  async getState(flowId: string | undefined, sourceId: string): Promise<SourceSyncState | undefined> {
    return this.states.get(stateKey(flowId, sourceId));
  }

  async setState(flowId: string | undefined, sourceId: string, lastSha: string): Promise<SourceSyncState> {
    const state: SourceSyncState = { flowId, sourceId, lastSha, lastCheckedAt: new Date().toISOString() };
    this.states.set(stateKey(flowId, sourceId), state);
    return state;
  }

  async createRun(input: SourceSyncRunInput): Promise<SourceSyncRun> {
    const terminal = input.status !== "running";
    const now = new Date().toISOString();
    const run: SourceSyncRun = {
      id: randomUUID(),
      flowId: input.flowId,
      destinationId: input.destinationId,
      sourceId: input.sourceId,
      trigger: input.trigger,
      status: input.status,
      jobId: input.jobId,
      plan: input.plan,
      error: input.error,
      fromSha: input.fromSha,
      toSha: input.toSha,
      changedFileCount: input.changedFileCount,
      candidateCount: input.candidateCount,
      createdAt: now,
      completedAt: terminal ? now : undefined
    };
    this.runs.set(run.id, run);
    return run;
  }

  async listRuns(limit: number): Promise<SourceSyncRun[]> {
    return [...this.runs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async getRun(id: string): Promise<SourceSyncRun | undefined> {
    return this.runs.get(id);
  }

  async recordRunPublication(id: string, publication: ProposalPublication): Promise<SourceSyncRun | undefined> {
    const existing = this.runs.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: SourceSyncRun = { ...existing, status: "published", publication };
    this.runs.set(id, updated);
    return updated;
  }

  async reset(): Promise<void> {
    this.states.clear();
    this.runs.clear();
  }
}
