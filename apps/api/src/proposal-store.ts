import { randomUUID } from "node:crypto";
import type { DraftMarkdownProposalJobOutput, Proposal } from "@magpie/core";

export interface ProposalInput extends DraftMarkdownProposalJobOutput {
  evidence: Proposal["evidence"];
  gapSummary?: string;
  triggeringQuestionIds?: string[];
  destinationId?: string;
  jobId?: string;
}

export interface ProposalStore {
  create(input: ProposalInput): Promise<Proposal>;
  list(limit: number): Promise<Proposal[]>;
  get(id: string): Promise<Proposal | undefined>;
  updateStatus(id: string, status: Proposal["status"]): Promise<Proposal | undefined>;
  recordPublication(id: string, publication: NonNullable<Proposal["publication"]>): Promise<Proposal | undefined>;
  reset(): Promise<void>;
}

export class InMemoryProposalStore implements ProposalStore {
  private readonly proposals = new Map<string, Proposal>();

  async create(input: ProposalInput): Promise<Proposal> {
    const proposal: Proposal = {
      id: randomUUID(),
      title: input.title,
      status: "draft",
      targetPath: input.targetPath,
      markdown: input.markdown,
      evidence: input.evidence,
      gapSummary: input.gapSummary,
      triggeringQuestionIds: input.triggeringQuestionIds,
      destinationId: input.destinationId,
      rationale: input.rationale,
      jobId: input.jobId,
      createdAt: new Date().toISOString()
    };

    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  async list(limit: number): Promise<Proposal[]> {
    return [...this.proposals.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async get(id: string): Promise<Proposal | undefined> {
    return this.proposals.get(id);
  }

  async updateStatus(id: string, status: Proposal["status"]): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: Proposal = {
      ...existing,
      status
    };
    this.proposals.set(id, updated);
    return updated;
  }

  async recordPublication(id: string, publication: NonNullable<Proposal["publication"]>): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: Proposal = {
      ...existing,
      publication,
      status: "branch-pushed"
    };
    this.proposals.set(id, updated);
    return updated;
  }

  async reset(): Promise<void> {
    this.proposals.clear();
  }
}
