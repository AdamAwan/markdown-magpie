import { randomUUID } from "node:crypto";
import { TERMINAL_PROPOSAL_STATUSES } from "@magpie/core";
import type {
  ChangesetChange,
  DraftContext,
  DraftMarkdownProposalJobOutput,
  Proposal,
  ProvenanceClaim,
  ReviewDecision
} from "@magpie/core";

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
  // Proposals with a given closure status, most recent first. Used by the parked
  // surface to find `needs_attention` proposals whose triggering question log was
  // deleted (the missing-log escalation, which files no parked gap row).
  listByClosureStatus(closureStatus: NonNullable<Proposal["closureStatus"]>, limit: number): Promise<Proposal[]>;
  get(id: string): Promise<Proposal | undefined>;
  getByJobId(jobId: string): Promise<Proposal | undefined>;
  // The proposal linked to a gap cluster, if any. Lets the reconciler look up one
  // cluster's proposal directly instead of scanning the whole proposal list. At
  // most one proposal links a cluster; when several exist (legacy data) the most
  // recent is returned, matching the old list(...).find() scan over created_at DESC.
  getByClusterId(gapClusterId: string): Promise<Proposal | undefined>;
  updateStatus(id: string, status: Proposal["status"]): Promise<Proposal | undefined>;
  // Records the gap-closure verification outcome for a merged proposal.
  setClosureStatus(id: string, closureStatus: NonNullable<Proposal["closureStatus"]>): Promise<Proposal | undefined>;
  recordPublication(id: string, publication: NonNullable<Proposal["publication"]>): Promise<Proposal | undefined>;
  linkCluster(id: string, gapClusterId: string): Promise<Proposal | undefined>;
  updateMarkdown(id: string, markdown: string): Promise<Proposal | undefined>;
  // Regenerate a stale proposal in place: refresh its markdown/rationale and bump
  // its regeneration counter. Title and targetPath are never rewritten, so the
  // derived branch name and open PR stay stable across regenerations.
  recordRegeneration(id: string, markdown: string, rationale?: string): Promise<Proposal | undefined>;
  // Promote a proposal to a merged file-set (used by the multi-file fold): replace
  // its changeset and refresh the primary markdown. targetPath is never rewritten.
  updateChangeset(id: string, changeset: ChangesetChange[], primaryMarkdown: string): Promise<Proposal | undefined>;
  // Replace the proposal's per-claim provenance (#214). The fold rewrites the
  // survivor's content, so its provenance event must be rewritten with it — the
  // only post-create provenance write. undefined clears the column.
  setProvenance(id: string, provenance: ProvenanceClaim[] | undefined): Promise<void>;
  updateReviewDecision(id: string, reviewDecision: ReviewDecision): Promise<Proposal | undefined>;
  // Merged proposals whose primary target or changeset touches `path`, oldest
  // merge first (event order). The provenance event stream for a document
  // (#214): each merged row records what supported its change when it shipped,
  // and the verify patrol folds this stream into advisory citedClaims.
  listMergedByTargetPath(path: string, limit: number): Promise<Proposal[]>;
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
      provenance: input.provenance,
      regenerationCount: 0,
      createdAt: new Date().toISOString()
    };

    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  async list(limit: number, options?: ProposalListOptions): Promise<Proposal[]> {
    return [...this.proposals.values()]
      .filter((proposal) =>
        options?.status ? proposal.status === options.status : !TERMINAL_PROPOSAL_STATUSES.includes(proposal.status)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async listByClosureStatus(closureStatus: NonNullable<Proposal["closureStatus"]>, limit: number): Promise<Proposal[]> {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.closureStatus === closureStatus)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async get(id: string): Promise<Proposal | undefined> {
    return this.proposals.get(id);
  }

  async getByJobId(jobId: string): Promise<Proposal | undefined> {
    return [...this.proposals.values()].find((proposal) => proposal.jobId === jobId);
  }

  async getByClusterId(gapClusterId: string): Promise<Proposal | undefined> {
    // Mirror the old list(500).find(): default list hides terminal statuses, so a
    // cluster whose only proposal is settled resolves to undefined here too.
    return [...this.proposals.values()]
      .filter(
        (proposal) => proposal.gapClusterId === gapClusterId && !TERMINAL_PROPOSAL_STATUSES.includes(proposal.status)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  async updateStatus(id: string, status: Proposal["status"]): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: Proposal = {
      ...existing,
      status,
      mergedAt: status === "merged" ? (existing.mergedAt ?? new Date().toISOString()) : existing.mergedAt
    };
    this.proposals.set(id, updated);
    return updated;
  }

  async setClosureStatus(
    id: string,
    closureStatus: NonNullable<Proposal["closureStatus"]>
  ): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: Proposal = { ...existing, closureStatus };
    this.proposals.set(id, updated);
    return updated;
  }

  async recordPublication(
    id: string,
    publication: NonNullable<Proposal["publication"]>
  ): Promise<Proposal | undefined> {
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

  async setProvenance(id: string, provenance: ProvenanceClaim[] | undefined): Promise<void> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return;
    }
    this.proposals.set(id, { ...existing, provenance });
  }

  async recordRegeneration(id: string, markdown: string, rationale?: string): Promise<Proposal | undefined> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: Proposal = {
      ...existing,
      markdown,
      rationale: rationale ?? existing.rationale,
      regenerationCount: (existing.regenerationCount ?? 0) + 1
    };
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

  async listMergedByTargetPath(path: string, limit: number): Promise<Proposal[]> {
    // Mirrors the Postgres ORDER BY merged_at ASC NULLS LAST: a merged row
    // somehow missing its stamp sorts after every stamped event.
    return [...this.proposals.values()]
      .filter(
        (proposal) =>
          proposal.status === "merged" &&
          (proposal.targetPath === path || (proposal.changeset ?? []).some((entry) => entry.path === path))
      )
      .sort((left, right) => {
        if (!left.mergedAt) return right.mergedAt ? 1 : 0;
        if (!right.mergedAt) return -1;
        return left.mergedAt.localeCompare(right.mergedAt);
      })
      .slice(0, limit);
  }

  async reset(): Promise<void> {
    this.proposals.clear();
  }
}
