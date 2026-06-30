// ReconciliationDecisionRecord is a canonical domain shape shared with the web
// console (which reads it back over /reconciliations), so it lives in @magpie/core
// rather than being declared here and mirrored by hand. The store-internal types
// below (the new-decision input and the store contract) stay here.
import type { ReconciliationDecisionRecord } from "@magpie/core";

export type NewReconciliationDecision = Omit<ReconciliationDecisionRecord, "id" | "createdAt">;

export interface ReconciliationDecisionStore {
  record(input: NewReconciliationDecision): Promise<ReconciliationDecisionRecord>;
  // Most recent first, capped at limit. Spans all flows; each record carries its
  // flowId so callers can group/label.
  list(limit: number): Promise<ReconciliationDecisionRecord[]>;
  reset(): Promise<void>;
}

export class InMemoryReconciliationDecisionStore implements ReconciliationDecisionStore {
  private readonly decisions: ReconciliationDecisionRecord[] = [];
  private seq = 0;

  async record(input: NewReconciliationDecision): Promise<ReconciliationDecisionRecord> {
    this.seq += 1;
    const decision: ReconciliationDecisionRecord = {
      id: `decision-${this.seq}`,
      flowId: input.flowId,
      kind: input.kind,
      rationale: input.rationale,
      confirmed: input.confirmed,
      applied: input.applied,
      clusterIds: input.clusterIds,
      createdAt: new Date().toISOString()
    };
    this.decisions.push(decision);
    return decision;
  }

  async list(limit: number): Promise<ReconciliationDecisionRecord[]> {
    return [...this.decisions].reverse().slice(0, limit);
  }

  async reset(): Promise<void> {
    this.decisions.length = 0;
    this.seq = 0;
  }
}
