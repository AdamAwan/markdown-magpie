import { randomUUID } from "node:crypto";
import type { ChangesetChange, CrunchPlan, ProposalPublication, SourceSyncRun, SourceSyncState } from "@magpie/core";

export interface SourceSyncRunInput {
  flowId?: string;
  destinationId?: string;
  sourceId: string;
  trigger: SourceSyncRun["trigger"];
  status: SourceSyncRun["status"];
  jobId?: string;
  plan?: CrunchPlan;
  changeset?: ChangesetChange[];
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
  getRunByJobId(jobId: string): Promise<SourceSyncRun | undefined>;
  completeRun(id: string, plan: CrunchPlan, changeset: ChangesetChange[]): Promise<SourceSyncRun | undefined>;
  markSkipped(id: string, plan: CrunchPlan): Promise<SourceSyncRun | undefined>;
  // running → deferred: the run's target file-set overlaps an open PR in the same
  // flow, so its changeset is preserved (never published as a rival) and re-gated
  // on a later tick. Persists plan + changeset; sets no completedAt; enqueues no
  // publication. No-op on a run that is no longer "running".
  deferRun(id: string, plan: CrunchPlan, changeset: ChangesetChange[]): Promise<SourceSyncRun | undefined>;
  // The re-gate worklist: deferred runs for a flow (default flow = undefined).
  listDeferredRuns(flowId: string | undefined): Promise<SourceSyncRun[]>;
  // deferred → completed: the overlap cleared, so the preserved changeset becomes
  // publishable through the normal publish pre-flight. Returns the run ONLY when this
  // call performed the transition; undefined when the run is missing or already
  // non-deferred. Callers gate publication on a defined result so two racing re-gate
  // ticks enqueue publication exactly once (the loser gets undefined and skips).
  completeDeferredRun(id: string): Promise<SourceSyncRun | undefined>;
  failRun(id: string, error: string): Promise<SourceSyncRun | undefined>;
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
      changeset: input.changeset,
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

  async getRunByJobId(jobId: string): Promise<SourceSyncRun | undefined> {
    // Match Postgres (ORDER BY created_at DESC): return the newest matching run.
    return [...this.runs.values()]
      .filter((run) => run.jobId === jobId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  async completeRun(id: string, plan: CrunchPlan, changeset: ChangesetChange[]): Promise<SourceSyncRun | undefined> {
    return this.transitionFromRunning(id, {
      status: "completed",
      plan,
      changeset,
      error: undefined,
      completedAt: new Date().toISOString()
    });
  }

  async markSkipped(id: string, plan: CrunchPlan): Promise<SourceSyncRun | undefined> {
    return this.transitionFromRunning(id, { status: "skipped", plan, completedAt: new Date().toISOString() });
  }

  async deferRun(id: string, plan: CrunchPlan, changeset: ChangesetChange[]): Promise<SourceSyncRun | undefined> {
    // Reuses the running-only guard: deferral is a transition out of "running",
    // like completeRun/markSkipped, but leaves completedAt unset (deferred is a
    // waiting state, not terminal).
    return this.transitionFromRunning(id, { status: "deferred", plan, changeset, error: undefined });
  }

  async listDeferredRuns(flowId: string | undefined): Promise<SourceSyncRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.status === "deferred" && (run.flowId ?? "") === (flowId ?? ""))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async completeDeferredRun(id: string): Promise<SourceSyncRun | undefined> {
    // Returns the run ONLY when this call performed the transition; undefined when the
    // run is missing or already non-deferred. The read-check-write is synchronous (no
    // await between), so under the single-threaded event loop exactly one of two racing
    // re-gates sees "deferred" — see the interface doc.
    const existing = this.runs.get(id);
    if (!existing || existing.status !== "deferred") {
      return undefined;
    }
    const updated: SourceSyncRun = { ...existing, status: "completed", completedAt: new Date().toISOString() };
    this.runs.set(id, updated);
    return updated;
  }

  async failRun(id: string, error: string): Promise<SourceSyncRun | undefined> {
    return this.transitionFromRunning(id, { status: "failed", error, completedAt: new Date().toISOString() });
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

  // Applies a terminal transition only to a still-running run, so a re-delivered
  // completion/failure never regresses a run that already reached a terminal state.
  private transitionFromRunning(id: string, patch: Partial<SourceSyncRun>): SourceSyncRun | undefined {
    const existing = this.runs.get(id);
    if (!existing) {
      return undefined;
    }
    if (existing.status !== "running") {
      return existing;
    }
    const updated: SourceSyncRun = { ...existing, ...patch };
    this.runs.set(id, updated);
    return updated;
  }

  async reset(): Promise<void> {
    this.states.clear();
    this.runs.clear();
  }
}
