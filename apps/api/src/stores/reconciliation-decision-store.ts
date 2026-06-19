// A single clustering decision the reconciler made while reshaping a flow's gap
// clusters: a proposed merge or split, the model's rationale for it, and whether
// the critic confirmed and the reconciler applied it. Persisted so a reviewer can
// see WHY the clustering changed, not just its result — previously this lived only
// in console logs.
export interface ReconciliationDecisionRecord {
  id: string;
  // The flow the reshape belongs to; undefined for the un-routed/default flow.
  flowId?: string;
  kind: "merge" | "split";
  // The proposing model's rationale for the merge/split.
  rationale: string;
  // The critic's verdict on the proposal.
  confirmed: boolean;
  // Whether the reconciler went on to apply it (only confirmed changes are applied).
  applied: boolean;
  // The clusters involved: every merged cluster, or the single cluster being split.
  clusterIds: string[];
  createdAt: string;
}

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
