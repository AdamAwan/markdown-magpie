import { createHash, randomUUID } from "node:crypto";
import type { AssertedClaim, AssertedClaimKind, AssertedClaimStatus, SourceConflictPosition } from "@magpie/core";

// A claim we made to a customer, in a previously-given questionnaire answer,
// that the sources do not support (ingesting completed questionnaires,
// docs/superpowers/specs/2026-08-11-questionnaire-ingestion-design.md D6).
//
// Distinct from the stage-2 agent's finding: the stored row carries identity,
// lifecycle and sighting counters the agent knows nothing about — exactly the
// split source_conflicts makes. The row shape itself lives in @magpie/core
// because it crosses the HTTP boundary to the console.
export type { AssertedClaim };
export interface AssertedClaimUpsert {
  flowId?: string;
  questionnaireId?: string;
  itemId?: string;
  kind: AssertedClaimKind;
  question: string;
  claim: string;
  positions: SourceConflictPosition[];
}

export interface AssertedClaimListOptions {
  flowId?: string;
  status?: AssertedClaimStatus;
  limit: number;
}

export interface AssertedClaimsStore {
  // Insert-or-bump on fingerprint. `created` is false for a re-sighting.
  open(input: AssertedClaimUpsert): Promise<{ claim: AssertedClaim; created: boolean }>;
  list(options: AssertedClaimListOptions): Promise<AssertedClaim[]>;
  get(id: string): Promise<AssertedClaim | undefined>;
  // The approval gate's query: does this item have a live finding against it?
  // A non-empty result forbids approving the IMPORTED wording, because approval
  // admits an answer into the match corpus and would re-serve an unbackable
  // claim to next quarter's customer with no human in the loop (spec D7).
  openForItem(itemId: string): Promise<AssertedClaim[]>;
  resolve(id: string, note: string): Promise<AssertedClaim | undefined>;
  dismiss(id: string, note: string): Promise<AssertedClaim | undefined>;
  reset(): Promise<void>;
}

// Sentinel for the unscoped (default) flow. Never an empty string or NULL:
// Postgres treats NULLs as distinct in a unique index, so a null-derived
// fingerprint would silently defeat dedupe on the default flow.
const DEFAULT_FLOW = " default";

// Identity for one finding, stable across re-ingestions of the same
// questionnaire. Keyed on the item and the normalised claim text rather than the
// question: one answer can assert several things, and each gets its own row so a
// reviewer resolves them independently.
export function assertedClaimFingerprint(input: {
  flowId?: string;
  itemId?: string;
  kind: AssertedClaimKind;
  claim: string;
}): string {
  const claim = input.claim.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256")
    .update(input.flowId ?? DEFAULT_FLOW)
    .update("\0")
    .update(input.itemId ?? "")
    .update("\0")
    .update(input.kind)
    .update("\0")
    .update(claim)
    .digest("hex");
}

export class InMemoryAssertedClaimsStore implements AssertedClaimsStore {
  private readonly claims = new Map<string, AssertedClaim>();

  async open(input: AssertedClaimUpsert): Promise<{ claim: AssertedClaim; created: boolean }> {
    const fingerprint = assertedClaimFingerprint(input);
    const now = new Date().toISOString();
    const existing = [...this.claims.values()].find((claim) => claim.fingerprint === fingerprint);
    if (existing) {
      // Refresh the observation but NEVER the status: a dismissed finding that
      // is re-detected must stay dismissed, or the register refills with
      // judgements the reviewer already made and stops being read.
      const updated: AssertedClaim = {
        ...existing,
        positions: input.positions,
        lastSeenAt: now,
        seenCount: existing.seenCount + 1
      };
      this.claims.set(updated.id, updated);
      return { claim: updated, created: false };
    }
    const claim: AssertedClaim = {
      id: randomUUID(),
      ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
      ...(input.questionnaireId !== undefined ? { questionnaireId: input.questionnaireId } : {}),
      ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
      kind: input.kind,
      question: input.question,
      claim: input.claim,
      positions: input.positions,
      status: "open",
      fingerprint,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1
    };
    this.claims.set(claim.id, claim);
    return { claim, created: true };
  }

  async list(options: AssertedClaimListOptions): Promise<AssertedClaim[]> {
    return [...this.claims.values()]
      .filter((claim) => (options.flowId === undefined ? true : claim.flowId === options.flowId))
      .filter((claim) => (options.status === undefined ? true : claim.status === options.status))
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, options.limit);
  }

  async get(id: string): Promise<AssertedClaim | undefined> {
    return this.claims.get(id);
  }

  async openForItem(itemId: string): Promise<AssertedClaim[]> {
    return [...this.claims.values()].filter((claim) => claim.status === "open" && claim.itemId === itemId);
  }

  async resolve(id: string, note: string): Promise<AssertedClaim | undefined> {
    return this.transition(id, { status: "resolved", resolutionNote: note, resolvedAt: new Date().toISOString() });
  }

  async dismiss(id: string, note: string): Promise<AssertedClaim | undefined> {
    return this.transition(id, { status: "dismissed", resolutionNote: note, resolvedAt: new Date().toISOString() });
  }

  private transition(id: string, patch: Partial<AssertedClaim>): AssertedClaim | undefined {
    const existing = this.claims.get(id);
    if (!existing) {
      return undefined;
    }
    const updated = { ...existing, ...patch };
    this.claims.set(id, updated);
    return updated;
  }

  async reset(): Promise<void> {
    this.claims.clear();
  }
}
