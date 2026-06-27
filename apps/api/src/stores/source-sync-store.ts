import type { SourceSyncState } from "@magpie/core";

// Persists what each flow/source has reacted to (the last processed commit).
// Source-sync execution history now lives in MaintenanceRun audit records.
export interface SourceSyncStore {
  getState(flowId: string | undefined, sourceId: string): Promise<SourceSyncState | undefined>;
  setState(flowId: string | undefined, sourceId: string, lastSha: string): Promise<SourceSyncState>;
  reset(): Promise<void>;
}

// A stable map key for the (optional flow id, source id) pair, so the default
// flow (undefined) gets exactly one state row per source.
function stateKey(flowId: string | undefined, sourceId: string): string {
  return `${flowId ?? ""}\0${sourceId}`;
}

export class InMemorySourceSyncStore implements SourceSyncStore {
  private readonly states = new Map<string, SourceSyncState>();

  async getState(flowId: string | undefined, sourceId: string): Promise<SourceSyncState | undefined> {
    return this.states.get(stateKey(flowId, sourceId));
  }

  async setState(flowId: string | undefined, sourceId: string, lastSha: string): Promise<SourceSyncState> {
    const state: SourceSyncState = { flowId, sourceId, lastSha, lastCheckedAt: new Date().toISOString() };
    this.states.set(stateKey(flowId, sourceId), state);
    return state;
  }

  async reset(): Promise<void> {
    this.states.clear();
  }
}
