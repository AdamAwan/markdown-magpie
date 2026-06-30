import { randomUUID } from "node:crypto";
import { TERMINAL_PROPOSAL_STATUSES } from "@magpie/core";
import type { ChangesetChange, DraftContext, DraftMarkdownProposalJobOutput, Proposal, ReviewDecision } from "@magpie/core";

export interface ProposalInput extends DraftMarkdownProposalJobOutput {
  evidence: Proposal["evidence"];
  gapSummary?: string;
  triggeringQuestionIds?: string[];
  destinationId?: string;
  jobId?: string;
  gapClusterId?: string;
  flowId?: string;
  // A multi-file file-set. When set, the proposal writes/deletes these documents
  // rather than the single targetPath/markdown; dedupe (and later split) set it.
  changeset?: ChangesetChange[];
  draftContext?: DraftContext;
}

export interface ProposalListOptions {
  // Returns only proposals in this status. When omitted, merged proposals are
  // excluded so the active list reflects work still in flight; merged proposals
  // remain fetchable as history via { status: "merged" }.
  status?: Proposal["status"];
}

export interface ProposalStore {
  create(input: ProposalInput): Promise<Proposal>;
  list(limit: number, options?: ProposalListOptions): Promise<Proposal[]>;
  get(id: string): Promise<Proposal | undefined>;
  getByJobId(jobId: string): Promise<Proposal | undefined>;
  updateStatus(id: string, status: Proposal["status"]): Promise<Proposal | undefined>;
  recordPublication(id: string, publication: NonNullable<Proposal["publication"]>): Promise<Proposal | undefined>;
  linkCluster(id: string, gapClusterId: string): Promise<Proposal | undefined>;
  updateMarkdown(id: string, markdown: string): Promise<Proposal | undefined>;
  // Promote a proposal to a merged file-set (used by the multi-file fold): replace
  // its changeset and refresh the primary markdown. targetPath is never rewritten.
  updateChangeset(id: string, changeset: ChangesetChange[], primaryMarkdown: string): Promise<Proposal | undefined>;
  updateReviewDecision(id: string, reviewDecision: ReviewDecision): Promise<Proposal | undefined>;
  reset(): Promise<void>;
}

export class InMemoryProposalStore implements ProposalStore {
  private readonly proposals = new Map<string, Proposal>();

  async create(input: ProposalInput): Promise<Proposal> {
    if (input.jobId) {
      const existing = await this.getByJobId(input.jobId);
      if (existing) return existing;
    }
    const proposal: Proposal = {
      id: randomUUID(),
      title: input.title,
      status: "draft",
      targetPath: input.targetPath,
      markdown: input.markdown,
      evidence: input.evidence,
      gapSummary: input.gapSummary,
      // Postgres coalesces a missing value to an empty array; mirror that here.
      triggeringQuestionIds: input.triggeringQuestionIds ?? [],
      destinationId: input.destinationId,
      rationale: input.rationale,
      jobId: input.jobId,
      gapClusterId: input.gapClusterId,
      flowId: input.flowId,
      changeset: input.changeset,
      draftContext: input.draftContext,
      createdAt: new Date().toISOString()
    };

    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  async list(limit: number, options?: ProposalListOptions): Promise<Proposal[]> {
    return [...this.proposals.values()]
      .filter((proposal) =>
        options?.status
          ? proposal.status === options.status
          : !TERMINAL_PROPOSAL_STATUSES.includes(proposal.status)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async get(id: string): Promise<Proposal | undefined> {
    return this.proposals.get(id);
  }

  async getByJobId(jobId: string): Promise<Proposal | undefined> {
    return [...this.proposals.values()].find((proposal) => proposal.jobId === jobId);
  }

  async updateStatus(id: string, status: Proposal["status"]): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: Proposal = {
      ...existing,
      status,
      mergedAt: status === "merged" ? existing.mergedAt ?? new Date().toISOString() : existing.mergedAt
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
      status: publication.pullRequestUrl ? "pr-opened" : "branch-pushed"
    };
    this.proposals.set(id, updated);
    return updated;
  }

  async linkCluster(id: string, gapClusterId: string): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: Proposal = { ...existing, gapClusterId };
    this.proposals.set(id, updated);
    return updated;
  }

  async updateMarkdown(id: string, markdown: string): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: Proposal = { ...existing, markdown };
    this.proposals.set(id, updated);
    return updated;
  }

  async updateChangeset(
    id: string,
    changeset: ChangesetChange[],
    primaryMarkdown: string
  ): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: Proposal = { ...existing, changeset, markdown: primaryMarkdown };
    this.proposals.set(id, updated);
    return updated;
  }

  async updateReviewDecision(id: string, reviewDecision: ReviewDecision): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: Proposal = { ...existing, reviewDecision };
    this.proposals.set(id, updated);
    return updated;
  }

  async reset(): Promise<void> {
    this.proposals.clear();
  }
}
