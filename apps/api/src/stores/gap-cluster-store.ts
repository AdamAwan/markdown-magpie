export interface GapClusterRecord {
  id: string;
  flowId?: string;
  title: string;
  rationale?: string;
  status: "active" | "frozen";
  parentClusterId?: string;
  reconciliationRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface GapClusterMembershipRecord {
  id: string;
  clusterId: string;
  gapId: string;
  active: boolean;
  rationale?: string;
  createdAt: string;
}

export interface PublicationActionRecord {
  id: string;
  proposalId: string;
  kind: "publish" | "supersede";
  status: "pending" | "done" | "failed";
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateClusterInput {
  flowId?: string;
  title: string;
  rationale?: string;
  parentClusterId?: string;
  revision: number;
}

export interface UpdateClusterInput {
  title?: string;
  rationale?: string;
  revision?: number;
}

export interface GapClusterStore {
  listActiveClusters(): Promise<GapClusterRecord[]>;
  getCluster(id: string): Promise<GapClusterRecord | undefined>;
  createCluster(input: CreateClusterInput): Promise<GapClusterRecord>;
  updateCluster(id: string, patch: UpdateClusterInput): Promise<GapClusterRecord | undefined>;
  freezeCluster(id: string): Promise<void>;

  listActiveMemberships(): Promise<GapClusterMembershipRecord[]>;
  listMembershipsForCluster(clusterId: string): Promise<GapClusterMembershipRecord[]>;
  // Moves a gap to `clusterId`, deactivating any other active membership it had.
  assignGapToCluster(clusterId: string, gapId: string, rationale?: string): Promise<void>;
  deactivateClusterMemberships(clusterId: string): Promise<void>;

  // Last catalog revision whose clustering is committed, per flow ('' is the
  // un-routed/default flow). Scoped per flow so each flow's reconciler gates on
  // its own progress. flowId omitted reads/writes the default flow.
  getProcessedRevision(flowId?: string): Promise<number>;
  setProcessedRevision(flowId: string | undefined, revision: number, lastRunAt: string): Promise<void>;

  enqueuePublicationAction(proposalId: string, kind: "publish" | "supersede"): Promise<PublicationActionRecord>;
  listPendingPublicationActions(): Promise<PublicationActionRecord[]>;
  markPublicationActionDone(id: string): Promise<void>;
  markPublicationActionFailed(id: string, error: string): Promise<void>;

  reset(): Promise<void>;
}

export class InMemoryGapClusterStore implements GapClusterStore {
  private clusters = new Map<string, GapClusterRecord>();
  private memberships = new Map<string, GapClusterMembershipRecord>();
  private actions = new Map<string, PublicationActionRecord>();
  // Processed revision per flow ('' is the un-routed/default flow).
  private processedRevision = new Map<string, number>();
  private processedRunAt = new Map<string, string>();
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private now(): string {
    // Tests run without Date.now restrictions here; ISO string is fine.
    return new Date().toISOString();
  }

  async listActiveClusters(): Promise<GapClusterRecord[]> {
    return [...this.clusters.values()]
      .filter((c) => c.status === "active")
      .sort((l, r) => l.id.localeCompare(r.id));
  }

  async getCluster(id: string): Promise<GapClusterRecord | undefined> {
    return this.clusters.get(id);
  }

  async createCluster(input: CreateClusterInput): Promise<GapClusterRecord> {
    const id = this.nextId("cluster");
    const now = this.now();
    const record: GapClusterRecord = {
      id,
      flowId: input.flowId,
      title: input.title,
      rationale: input.rationale,
      status: "active",
      parentClusterId: input.parentClusterId,
      reconciliationRevision: input.revision,
      createdAt: now,
      updatedAt: now
    };
    this.clusters.set(id, record);
    return record;
  }

  async updateCluster(id: string, patch: UpdateClusterInput): Promise<GapClusterRecord | undefined> {
    const existing = this.clusters.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: GapClusterRecord = {
      ...existing,
      title: patch.title ?? existing.title,
      rationale: patch.rationale ?? existing.rationale,
      reconciliationRevision: patch.revision ?? existing.reconciliationRevision,
      updatedAt: this.now()
    };
    this.clusters.set(id, updated);
    return updated;
  }

  async freezeCluster(id: string): Promise<void> {
    const existing = this.clusters.get(id);
    if (existing) {
      this.clusters.set(id, { ...existing, status: "frozen", updatedAt: this.now() });
    }
  }

  async listActiveMemberships(): Promise<GapClusterMembershipRecord[]> {
    return [...this.memberships.values()].filter((m) => m.active);
  }

  async listMembershipsForCluster(clusterId: string): Promise<GapClusterMembershipRecord[]> {
    return [...this.memberships.values()].filter((m) => m.active && m.clusterId === clusterId);
  }

  async assignGapToCluster(clusterId: string, gapId: string, rationale?: string): Promise<void> {
    for (const [key, m] of this.memberships) {
      if (m.active && m.gapId === gapId) {
        this.memberships.set(key, { ...m, active: false });
      }
    }
    const id = this.nextId("membership");
    this.memberships.set(id, { id, clusterId, gapId, active: true, rationale, createdAt: this.now() });
  }

  async deactivateClusterMemberships(clusterId: string): Promise<void> {
    for (const [key, m] of this.memberships) {
      if (m.active && m.clusterId === clusterId) {
        this.memberships.set(key, { ...m, active: false });
      }
    }
  }

  async getProcessedRevision(flowId?: string): Promise<number> {
    return this.processedRevision.get(flowId ?? "") ?? 0;
  }

  async setProcessedRevision(flowId: string | undefined, revision: number, lastRunAt: string): Promise<void> {
    this.processedRevision.set(flowId ?? "", revision);
    this.processedRunAt.set(flowId ?? "", lastRunAt);
  }

  async enqueuePublicationAction(proposalId: string, kind: "publish" | "supersede"): Promise<PublicationActionRecord> {
    const id = this.nextId("action");
    const now = this.now();
    const record: PublicationActionRecord = {
      id,
      proposalId,
      kind,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };
    this.actions.set(id, record);
    return record;
  }

  async listPendingPublicationActions(): Promise<PublicationActionRecord[]> {
    return [...this.actions.values()]
      .filter((a) => a.status === "pending" || a.status === "failed")
      .sort((l, r) => l.createdAt.localeCompare(r.createdAt));
  }

  async markPublicationActionDone(id: string): Promise<void> {
    const existing = this.actions.get(id);
    if (existing) {
      this.actions.set(id, { ...existing, status: "done", updatedAt: this.now() });
    }
  }

  async markPublicationActionFailed(id: string, error: string): Promise<void> {
    const existing = this.actions.get(id);
    if (existing) {
      this.actions.set(id, {
        ...existing,
        status: "failed",
        attempts: existing.attempts + 1,
        lastError: error,
        updatedAt: this.now()
      });
    }
  }

  async reset(): Promise<void> {
    this.clusters.clear();
    this.memberships.clear();
    this.actions.clear();
    this.processedRevision.clear();
    this.processedRunAt.clear();
    this.seq = 0;
  }
}
