import { randomUUID } from "node:crypto";
import type { SeedPlan, SeedPlanItem, SeedPlanStatus } from "@magpie/core";

// The write shape for a freshly proposed plan (the outline_flow_seed completion
// handler builds this). Item ids/statuses are assigned by the store: every item
// starts "proposed" with a stable uuid so PATCH edits and approve-replay can
// address it unambiguously.
export interface NewSeedPlan {
  flowId: string;
  origin: "manual" | "auto";
  charter?: string;
  persona?: string;
  charterProposed: boolean;
  personaProposed: boolean;
  items: Omit<SeedPlanItem, "id" | "status" | "draftJobId">[];
  rationale: string;
  notes?: string;
  outlineJobId: string;
  sourceHash: string;
}

// One reviewer edit to one plan item, addressed by the item's stable id.
// Unknown ids are ignored (a concurrent supersede may have replaced the plan).
export interface SeedPlanItemPatch {
  id: string;
  title?: string;
  targetPath?: string;
  coverage?: string[];
  questions?: string[];
  status?: "proposed" | "approved" | "dismissed";
}

// Persisted, human-reviewable seed plans (self-seeding flows). Store-level
// operations only — status-transition rules ("only while proposed") live in
// the seed service.
export interface SeedPlanStore {
  // Idempotent on outlineJobId: a re-delivered completion returns the existing plan.
  create(plan: NewSeedPlan): Promise<SeedPlan>;
  get(id: string): Promise<SeedPlan | undefined>;
  listByFlow(flowId: string): Promise<SeedPlan[]>; // newest first
  latestByFlow(flowId: string, status: SeedPlanStatus): Promise<SeedPlan | undefined>;
  setStatus(id: string, status: SeedPlanStatus): Promise<SeedPlan | undefined>;
  // Applies reviewer edits (charter/persona text + per-item patches).
  patch(
    id: string,
    patch: { charter?: string; persona?: string; items?: SeedPlanItemPatch[] }
  ): Promise<SeedPlan | undefined>;
  // Replaces the plan's items wholesale (fresh proposed ids, like create) and
  // updates rationale; charter/persona are updated only when provided. Used by
  // the revise_seed_plan completion handler; the "only while proposed" rule is
  // enforced in the seed service.
  revise(
    id: string,
    next: {
      items: Omit<SeedPlanItem, "id" | "status" | "draftJobId">[];
      charter?: string;
      persona?: string;
      rationale: string;
    }
  ): Promise<SeedPlan | undefined>;
  setItemDraftJob(id: string, itemId: string, draftJobId: string): Promise<SeedPlan | undefined>;
  reset(): Promise<void>;
}

function patchItem(item: SeedPlanItem, patch: SeedPlanItemPatch): SeedPlanItem {
  return {
    ...item,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.targetPath !== undefined ? { targetPath: patch.targetPath } : {}),
    ...(patch.coverage !== undefined ? { coverage: [...patch.coverage] } : {}),
    ...(patch.questions !== undefined ? { questions: [...patch.questions] } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {})
  };
}

export class InMemorySeedPlanStore implements SeedPlanStore {
  private readonly plans = new Map<string, SeedPlan>();
  // createdAt has only millisecond resolution, so plans created in the same tick
  // can tie; a monotonic sequence keeps "newest first" reflecting write order.
  private readonly sequence = new Map<string, number>();
  private nextSequence = 0;

  async create(plan: NewSeedPlan): Promise<SeedPlan> {
    const existing = [...this.plans.values()].find((candidate) => candidate.outlineJobId === plan.outlineJobId);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const record: SeedPlan = {
      id: randomUUID(),
      flowId: plan.flowId,
      status: "proposed",
      origin: plan.origin,
      ...(plan.charter !== undefined ? { charter: plan.charter } : {}),
      ...(plan.persona !== undefined ? { persona: plan.persona } : {}),
      charterProposed: plan.charterProposed,
      personaProposed: plan.personaProposed,
      items: plan.items.map((item) => ({ ...item, id: randomUUID(), status: "proposed" as const })),
      rationale: plan.rationale,
      ...(plan.notes !== undefined ? { notes: plan.notes } : {}),
      outlineJobId: plan.outlineJobId,
      sourceHash: plan.sourceHash,
      createdAt: now,
      updatedAt: now
    };
    this.plans.set(record.id, record);
    this.sequence.set(record.id, this.nextSequence++);
    return record;
  }

  async get(id: string): Promise<SeedPlan | undefined> {
    return this.plans.get(id);
  }

  async listByFlow(flowId: string): Promise<SeedPlan[]> {
    return [...this.plans.values()]
      .filter((plan) => plan.flowId === flowId)
      .sort((left, right) => {
        const byTime = right.createdAt.localeCompare(left.createdAt);
        if (byTime !== 0) {
          return byTime;
        }
        return (this.sequence.get(right.id) ?? 0) - (this.sequence.get(left.id) ?? 0);
      });
  }

  async latestByFlow(flowId: string, status: SeedPlanStatus): Promise<SeedPlan | undefined> {
    return (await this.listByFlow(flowId)).find((plan) => plan.status === status);
  }

  async setStatus(id: string, status: SeedPlanStatus): Promise<SeedPlan | undefined> {
    const existing = this.plans.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: SeedPlan = { ...existing, status, updatedAt: new Date().toISOString() };
    this.plans.set(id, updated);
    return updated;
  }

  async patch(
    id: string,
    patch: { charter?: string; persona?: string; items?: SeedPlanItemPatch[] }
  ): Promise<SeedPlan | undefined> {
    const existing = this.plans.get(id);
    if (!existing) {
      return undefined;
    }
    const patchesById = new Map((patch.items ?? []).map((itemPatch) => [itemPatch.id, itemPatch]));
    const updated: SeedPlan = {
      ...existing,
      ...(patch.charter !== undefined ? { charter: patch.charter } : {}),
      ...(patch.persona !== undefined ? { persona: patch.persona } : {}),
      items: existing.items.map((item) => {
        const itemPatch = patchesById.get(item.id);
        return itemPatch ? patchItem(item, itemPatch) : item;
      }),
      updatedAt: new Date().toISOString()
    };
    this.plans.set(id, updated);
    return updated;
  }

  async revise(
    id: string,
    next: {
      items: Omit<SeedPlanItem, "id" | "status" | "draftJobId">[];
      charter?: string;
      persona?: string;
      rationale: string;
    }
  ): Promise<SeedPlan | undefined> {
    const existing = this.plans.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: SeedPlan = {
      ...existing,
      ...(next.charter !== undefined ? { charter: next.charter } : {}),
      ...(next.persona !== undefined ? { persona: next.persona } : {}),
      items: next.items.map((item) => ({ ...item, id: randomUUID(), status: "proposed" as const })),
      rationale: next.rationale,
      updatedAt: new Date().toISOString()
    };
    this.plans.set(id, updated);
    return updated;
  }

  async setItemDraftJob(id: string, itemId: string, draftJobId: string): Promise<SeedPlan | undefined> {
    const existing = this.plans.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: SeedPlan = {
      ...existing,
      items: existing.items.map((item) => (item.id === itemId ? { ...item, draftJobId } : item)),
      updatedAt: new Date().toISOString()
    };
    this.plans.set(id, updated);
    return updated;
  }

  async reset(): Promise<void> {
    this.plans.clear();
    this.sequence.clear();
    this.nextSequence = 0;
  }
}
