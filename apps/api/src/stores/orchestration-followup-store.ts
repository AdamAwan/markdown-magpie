// Continuation state for the non-blocking maintenance orchestrators (see
// migration 0070_orchestration_followups.sql and
// docs/superpowers/specs/2026-11-27-non-blocking-orchestrators-design.md).
//
// An orchestrator enqueues a follow-up AI job, registers a row here keyed by that
// job's id, and returns. When the job completes, the completion dispatcher looks
// the row up to find the orchestration to resume. A job with no row is simply not
// an orchestrated follow-up (a live /api/ask, a manually created job), so every
// continuation is a no-op for it.

// The orchestrations that resume from a follow-up job's completion.
export type FollowupOrchestrator = "verify_gap_closure" | "process_gaps_to_pull_requests" | "correctness_patrol";

export interface OrchestrationFollowup {
  jobId: string;
  orchestrator: FollowupOrchestrator;
  // The unit the orchestration settles as a whole: a proposal id
  // (verify_gap_closure), a flow key (process_gaps_to_pull_requests), or a patrol
  // run id (correctness_patrol).
  scopeKey: string;
  // What the continuation needs beyond the job's own input/output. Opaque here;
  // each orchestrator parses its own shape.
  context: unknown;
  // `pending` until the follow-up's outcome has been applied. The broker stays the
  // source of truth for whether the JOB is still running — a pending row whose job
  // is terminal is an outcome nobody has applied yet, not work in flight.
  status: "pending" | "settled";
  // The applied outcome, kept so a scope can be settled from its rows alone.
  result?: unknown;
  createdAt: string;
  settledAt?: string;
}

export type OrchestrationFollowupInput = Pick<OrchestrationFollowup, "jobId" | "orchestrator" | "scopeKey" | "context">;

export interface OrchestrationFollowupStore {
  // Insert-if-absent: a job id already registered keeps its original row (an
  // in-flight job reused by a later tick stays owned by the orchestration that
  // enqueued it). Returns the stored row either way.
  register(input: OrchestrationFollowupInput): Promise<OrchestrationFollowup>;
  get(jobId: string): Promise<OrchestrationFollowup | undefined>;
  // Every row of a scope, oldest first.
  listByScope(orchestrator: FollowupOrchestrator, scopeKey: string): Promise<OrchestrationFollowup[]>;
  setContext(jobId: string, context: unknown): Promise<void>;
  // pending → settled, recording the outcome. Returns true only for the call that
  // made the transition, so a replayed continuation can tell it was already applied.
  settle(jobId: string, result: unknown): Promise<boolean>;
  deleteScope(orchestrator: FollowupOrchestrator, scopeKey: string): Promise<void>;
  // Drops one orchestrator's settled rows older than `before` (ISO timestamp) —
  // but only from scopes that have FINISHED, i.e. hold no pending row. A settled
  // row in a scope that is still waiting on a sibling is that orchestration's
  // memory of work already paid for (an answered re-ask, a verdict already
  // applied); pruning it would make a later re-drive buy it again. Pending rows
  // are never pruned: they are outcomes still owed.
  pruneSettledBefore(orchestrator: FollowupOrchestrator, before: string): Promise<void>;
  reset(): Promise<void>;
}

export class InMemoryOrchestrationFollowupStore implements OrchestrationFollowupStore {
  // Insertion order is creation order, which is what listByScope returns.
  private readonly rows = new Map<string, OrchestrationFollowup>();

  async register(input: OrchestrationFollowupInput): Promise<OrchestrationFollowup> {
    const existing = this.rows.get(input.jobId);
    if (existing) {
      return existing;
    }
    const row: OrchestrationFollowup = { ...input, status: "pending", createdAt: new Date().toISOString() };
    this.rows.set(input.jobId, row);
    return row;
  }

  async get(jobId: string): Promise<OrchestrationFollowup | undefined> {
    return this.rows.get(jobId);
  }

  async listByScope(orchestrator: FollowupOrchestrator, scopeKey: string): Promise<OrchestrationFollowup[]> {
    return [...this.rows.values()].filter((row) => row.orchestrator === orchestrator && row.scopeKey === scopeKey);
  }

  async setContext(jobId: string, context: unknown): Promise<void> {
    const row = this.rows.get(jobId);
    if (row) {
      this.rows.set(jobId, { ...row, context });
    }
  }

  async settle(jobId: string, result: unknown): Promise<boolean> {
    const row = this.rows.get(jobId);
    if (!row || row.status !== "pending") {
      return false;
    }
    this.rows.set(jobId, { ...row, status: "settled", result, settledAt: new Date().toISOString() });
    return true;
  }

  async deleteScope(orchestrator: FollowupOrchestrator, scopeKey: string): Promise<void> {
    for (const row of [...this.rows.values()]) {
      if (row.orchestrator === orchestrator && row.scopeKey === scopeKey) {
        this.rows.delete(row.jobId);
      }
    }
  }

  async pruneSettledBefore(orchestrator: FollowupOrchestrator, before: string): Promise<void> {
    const all = [...this.rows.values()].filter((row) => row.orchestrator === orchestrator);
    const unfinishedScopes = new Set(all.filter((row) => row.status === "pending").map((row) => row.scopeKey));
    for (const row of all) {
      if (
        row.status === "settled" &&
        row.settledAt !== undefined &&
        row.settledAt < before &&
        !unfinishedScopes.has(row.scopeKey)
      ) {
        this.rows.delete(row.jobId);
      }
    }
  }

  async reset(): Promise<void> {
    this.rows.clear();
  }
}
