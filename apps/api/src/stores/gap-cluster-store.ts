export interface GapClusterRecord {
  id: string;
  flowId?: string;
  title: string;
  rationale?: string;
  // "dismissed" = the reconciler judged the cluster off-topic for the knowledge base
  // and dropped it permanently. Like "frozen", a dismissed cluster leaves the active
  // set so it never drafts; unlike "frozen" (covered/declined), its underlying gaps
  // are also dismissed so they never re-cluster.
  status: "active" | "frozen" | "dismissed";
  parentClusterId?: string;
  reconciliationRevision: number;
  // L2-normalised centroid of the cluster's distinct active member gap-summary
  // embeddings, used by the reconciler's phase-1 assignment. Undefined = not
  // yet computed, or invalidated by a composition change (reshape merge/split,
  // resolved-gap pruning) — the next assignment pass recomputes it lazily.
  representativeEmbedding?: number[];
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
  representativeEmbedding?: number[];
}

export interface UpdateClusterInput {
  title?: string;
  rationale?: string;
  revision?: number;
}

export interface GapClusterStore {
  listActiveClusters(): Promise<GapClusterRecord[]>;
  // Active clusters scoped to one flow ('' / undefined is the un-routed/default
  // flow) in SQL, so the reconciler doesn't load every flow's clusters and filter
  // in JS each tick. `limit` bounds the scan; clusters are ordered by id ASC to
  // match listActiveClusters.
  listActiveClustersForFlow(flowId: string | undefined, limit?: number): Promise<GapClusterRecord[]>;
  getCluster(id: string): Promise<GapClusterRecord | undefined>;
  createCluster(input: CreateClusterInput): Promise<GapClusterRecord>;
  updateCluster(id: string, patch: UpdateClusterInput): Promise<GapClusterRecord | undefined>;
  freezeCluster(id: string): Promise<void>;
  // Permanently marks a cluster off-topic for the knowledge base. Like freezing, it
  // leaves the active set; the reconciler also dismisses the cluster's member gaps so
  // they never re-surface. The rationale is stored on the cluster for audit.
  dismissCluster(id: string, rationale?: string): Promise<void>;
  // Sets or clears (null) the cluster's representative embedding. Cleared when
  // a reshape or prune changes the cluster's composition so the next assignment
  // pass recomputes the centroid from the surviving members.
  setClusterRepresentative(id: string, embedding: number[] | null): Promise<void>;

  listActiveMemberships(): Promise<GapClusterMembershipRecord[]>;
  // Active memberships whose cluster belongs to one flow, resolved in SQL so the
  // reconciler only loads its own flow's assigned-gap set rather than every flow's.
  listActiveMembershipsForFlow(flowId: string | undefined): Promise<GapClusterMembershipRecord[]>;
  listMembershipsForCluster(clusterId: string): Promise<GapClusterMembershipRecord[]>;
  // Moves a gap to `clusterId`, deactivating any other active membership it had.
  assignGapToCluster(clusterId: string, gapId: string, rationale?: string): Promise<void>;
  // Batched assignGapToCluster: moves many gaps into `clusterId` in one
  // transaction (deactivate prior memberships, then a single multi-row insert),
  // instead of one transaction/round-trip per gap. Order of gapIds is preserved.
  assignGapsToCluster(clusterId: string, gapIds: string[], rationale?: string): Promise<void>;
  deactivateClusterMemberships(clusterId: string): Promise<void>;
  // Deactivates any active membership whose gap is in the given set, wherever it
  // lives. Used to evict gaps that have been resolved (covered) from the active
  // cluster currently holding them, regardless of which cluster resolved them.
  deactivateMembershipsForGaps(gapIds: string[]): Promise<void>;

  // Last catalog revision whose clustering is committed, per flow ('' is the
  // un-routed/default flow). Scoped per flow so each flow's reconciler gates on
  // its own progress. flowId omitted reads/writes the default flow.
  getProcessedRevision(flowId?: string): Promise<number>;
  setProcessedRevision(flowId: string | undefined, revision: number, lastRunAt: string): Promise<void>;

  // Composition hash of the active cluster set last sent to the reshape critic for
  // this flow, or undefined if this flow has never been reshaped. The reconciler
  // skips the metered propose→critic reshape when the current active composition
  // hashes to the same value — a revision bump that leaves the cluster set
  // unchanged no longer re-judges an identical set (issue #168). Only recorded
  // after a completed reshape, so a failed/timed-out one never wedges the gate.
  getReshapeCompositionHash(flowId?: string): Promise<string | undefined>;
  setReshapeCompositionHash(flowId: string | undefined, hash: string): Promise<void>;

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
  // Composition hash of the last reshaped active set per flow ('' is default).
  private reshapeCompositionHash = new Map<string, string>();
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

  async listActiveClustersForFlow(
    flowId: string | undefined,
    limit?: number
  ): Promise<GapClusterRecord[]> {
    const flow = flowId ?? "";
    const matches = [...this.clusters.values()]
      .filter((c) => c.status === "active" && (c.flowId ?? "") === flow)
      .sort((l, r) => l.id.localeCompare(r.id));
    return limit === undefined ? matches : matches.slice(0, limit);
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
      representativeEmbedding: input.representativeEmbedding,
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

  async dismissCluster(id: string, rationale?: string): Promise<void> {
    const existing = this.clusters.get(id);
    if (existing) {
      this.clusters.set(id, {
        ...existing,
        status: "dismissed",
        ...(rationale ? { rationale } : {}),
        updatedAt: this.now()
      });
    }
  }

  async setClusterRepresentative(id: string, embedding: number[] | null): Promise<void> {
    const existing = this.clusters.get(id);
    if (existing) {
      const { representativeEmbedding: _cleared, ...rest } = existing;
      this.clusters.set(id, {
        ...rest,
        ...(embedding ? { representativeEmbedding: embedding } : {}),
        updatedAt: this.now()
      });
    }
  }

  async listActiveMemberships(): Promise<GapClusterMembershipRecord[]> {
    return [...this.memberships.values()].filter((m) => m.active);
  }

  async listActiveMembershipsForFlow(flowId: string | undefined): Promise<GapClusterMembershipRecord[]> {
    const flow = flowId ?? "";
    return [...this.memberships.values()].filter((m) => {
      if (!m.active) {
        return false;
      }
      const cluster = this.clusters.get(m.clusterId);
      return (cluster?.flowId ?? "") === flow;
    });
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

  async assignGapsToCluster(clusterId: string, gapIds: string[], rationale?: string): Promise<void> {
    for (const gapId of gapIds) {
      await this.assignGapToCluster(clusterId, gapId, rationale);
    }
  }

  async deactivateClusterMemberships(clusterId: string): Promise<void> {
    for (const [key, m] of this.memberships) {
      if (m.active && m.clusterId === clusterId) {
        this.memberships.set(key, { ...m, active: false });
      }
    }
  }

  async deactivateMembershipsForGaps(gapIds: string[]): Promise<void> {
    const gapSet = new Set(gapIds);
    for (const [key, m] of this.memberships) {
      if (m.active && gapSet.has(m.gapId)) {
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

  async getReshapeCompositionHash(flowId?: string): Promise<string | undefined> {
    return this.reshapeCompositionHash.get(flowId ?? "");
  }

  async setReshapeCompositionHash(flowId: string | undefined, hash: string): Promise<void> {
    this.reshapeCompositionHash.set(flowId ?? "", hash);
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
    this.reshapeCompositionHash.clear();
    this.seq = 0;
  }
}
