import { randomUUID } from "node:crypto";
import type {
  AnswerResult,
  GapCandidate,
  QuestionFeedback,
  QuestionGap,
  QuestionLog,
  QuestionLogInput,
  QuestionLogUpdateInput
} from "@magpie/core";

function autoGapsFromAnswer(answer: AnswerResult | undefined): QuestionGap[] {
  return (answer?.gaps ?? []).map((gap) => ({ summary: gap.summary, source: "auto" as const }));
}

export interface QuestionLogStore {
  record(input: QuestionLogInput): Promise<QuestionLog>;
  updateAnswer(id: string, input: QuestionLogUpdateInput): Promise<QuestionLog | undefined>;
  recordFeedback(id: string, feedback: QuestionFeedback): Promise<QuestionLog | undefined>;
  recordManualGap(id: string, summary?: string): Promise<QuestionLog | undefined>;
  clearManualGap(id: string): Promise<QuestionLog | undefined>;
  // Soft-resolves the gaps closed by a merged proposal: the matching rows are
  // retained for audit but stop surfacing as candidates. Returns how many gaps
  // were newly resolved.
  resolveGaps(questionIds: string[], summaries: string[], proposalId: string): Promise<number>;
  get(id: string): Promise<QuestionLog | undefined>;
  list(limit: number): Promise<QuestionLog[]>;
  listGapCandidates(limit: number): Promise<GapCandidate[]>;
  // Monotonic counter advanced whenever the unresolved candidate gaps change
  // (added, removed, or resolved). Tracked per flow so a gap change in one flow
  // doesn't force every flow to re-cluster; the reconciler compares its flow's
  // counter to its processed revision to decide whether model work is needed.
  // flowId omitted reads the un-routed/default flow.
  getGapCatalogRevision(flowId?: string): Promise<number>;
  // Stable ids of the unresolved gap rows matching a summary within a flow. The
  // reconciler keys cluster memberships off these. Postgres returns the bigint
  // question_gaps.id; the in-memory store returns a stable synthetic id.
  gapIdsForSummary(summary: string, flowId?: string): Promise<string[]>;
  // Resolves a set of gap ids (as produced by gapIdsForSummary) back to their
  // distinct summaries and question ids, for the cluster read path.
  gapDetailsForIds(gapIds: string[]): Promise<{ summaries: string[]; questionIds: string[] }>;
  reset(): Promise<void>;
}

export class InMemoryQuestionLogStore implements QuestionLogStore {
  private readonly logs = new Map<string, QuestionLog>();
  // Catalog revision per flow ('' is the un-routed/default flow), mirroring the
  // per-flow gap_catalog table in Postgres.
  private readonly gapCatalogRevision = new Map<string, number>();

  private bumpCatalog(flowId?: string): void {
    const key = flowId ?? "";
    this.gapCatalogRevision.set(key, (this.gapCatalogRevision.get(key) ?? 0) + 1);
  }

  async getGapCatalogRevision(flowId?: string): Promise<number> {
    return this.gapCatalogRevision.get(flowId ?? "") ?? 0;
  }

  async gapIdsForSummary(summary: string, flowId?: string): Promise<string[]> {
    const ids: string[] = [];
    for (const log of this.logs.values()) {
      if ((log.flowId ?? "") !== (flowId ?? "")) {
        continue;
      }
      for (const gap of log.gaps ?? []) {
        if (gap.resolvedAt || gap.summary !== summary) {
          continue;
        }
        // Synthetic, stable id: the gap row has no surrogate key in memory, so we
        // encode (questionId, summary). gapDetailsForIds parses it back.
        ids.push(`${log.id}::${gap.summary}`);
      }
    }
    return ids;
  }

  async gapDetailsForIds(gapIds: string[]): Promise<{ summaries: string[]; questionIds: string[] }> {
    const summaries = new Set<string>();
    const questionIds = new Set<string>();
    for (const id of gapIds) {
      const sep = id.indexOf("::");
      if (sep === -1) {
        continue;
      }
      questionIds.add(id.slice(0, sep));
      summaries.add(id.slice(sep + 2));
    }
    return { summaries: [...summaries], questionIds: [...questionIds] };
  }

  async record(input: QuestionLogInput): Promise<QuestionLog> {
    const log: QuestionLog = {
      id: randomUUID(),
      question: input.question,
      executionMode: input.executionMode,
      chatProvider: input.chatProvider,
      confidence: input.answer?.confidence ?? "unknown",
      retrievedSectionIds: input.retrievedSectionIds,
      answer: input.answer,
      gaps: autoGapsFromAnswer(input.answer),
      // Match the Postgres column default (manual_gap boolean NOT NULL DEFAULT false).
      manualGap: false,
      askedAt: new Date().toISOString(),
      ...(input.flowId ? { flowId: input.flowId } : {})
    };

    this.logs.set(log.id, log);
    if (log.gaps && log.gaps.length > 0) {
      this.bumpCatalog(log.flowId);
    }
    return log;
  }

  async get(id: string): Promise<QuestionLog | undefined> {
    return this.logs.get(id);
  }

  async updateAnswer(id: string, input: QuestionLogUpdateInput): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }

    // The flow is decided by the watcher after the log is recorded, so a
    // completion can supply it now; fall back to any flow already on the log.
    const flowId = input.flowId ?? existing.flowId;
    const updated: QuestionLog = {
      ...existing,
      chatProvider: input.chatProvider ?? existing.chatProvider,
      confidence: input.answer.confidence,
      retrievedSectionIds: input.answer.citations.map((citation) => citation.sectionId),
      answer: input.answer,
      // Re-answering replaces auto-detected gaps but preserves any manual flag.
      gaps: [
        ...(existing.gaps ?? []).filter((gap) => gap.source === "manual"),
        ...autoGapsFromAnswer(input.answer)
      ],
      ...(flowId ? { flowId } : {})
    };

    this.logs.set(id, updated);
    // Re-answering replaces the auto-detected gaps, changing the candidate set.
    this.bumpCatalog(flowId);
    return updated;
  }

  async recordFeedback(id: string, feedback: QuestionFeedback): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: QuestionLog = {
      ...existing,
      feedback,
      feedbackAt: new Date().toISOString()
    };

    this.logs.set(id, updated);
    return updated;
  }

  async recordManualGap(id: string, summary?: string): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }

    const trimmed = summary?.trim();
    const manualGap: QuestionGap = { summary: trimmed || existing.question, source: "manual" };
    const updated: QuestionLog = {
      ...existing,
      manualGap: true,
      manualGapAt: new Date().toISOString(),
      // Replace any prior manual gap; auto-detected gaps are left untouched.
      gaps: [...(existing.gaps ?? []).filter((gap) => gap.source !== "manual"), manualGap]
    };

    this.logs.set(id, updated);
    this.bumpCatalog(existing.flowId);
    return updated;
  }

  async clearManualGap(id: string): Promise<QuestionLog | undefined> {
    const existing = this.logs.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: QuestionLog = {
      ...existing,
      manualGap: false,
      manualGapAt: undefined,
      // Drop the manual flag's gap; any auto-detected gaps remain candidates.
      gaps: (existing.gaps ?? []).filter((gap) => gap.source !== "manual")
    };

    this.logs.set(id, updated);
    if (existing.manualGap) {
      this.bumpCatalog(existing.flowId);
    }
    return updated;
  }

  async resolveGaps(questionIds: string[], summaries: string[], proposalId: string): Promise<number> {
    const questionSet = new Set(questionIds);
    const summarySet = new Set(summaries.map((summary) => summary.trim()).filter((summary) => summary.length > 0));
    if (questionSet.size === 0 || summarySet.size === 0) {
      return 0;
    }

    const resolvedAt = new Date().toISOString();
    let resolved = 0;
    // Bump every flow that actually had a gap resolved (a proposal's questions
    // share a flow in practice, but resolving spans whatever the caller passes).
    const resolvedFlows = new Set<string>();
    for (const log of this.logs.values()) {
      if (!questionSet.has(log.id) || !log.gaps?.length) {
        continue;
      }

      let resolvedHere = 0;
      const gaps = log.gaps.map((gap) => {
        if (gap.resolvedAt || !summarySet.has(gap.summary)) {
          return gap;
        }
        resolved += 1;
        resolvedHere += 1;
        return { ...gap, resolvedAt, resolvedByProposalId: proposalId };
      });
      this.logs.set(log.id, { ...log, gaps });
      if (resolvedHere > 0) {
        resolvedFlows.add(log.flowId ?? "");
      }
    }

    for (const flow of resolvedFlows) {
      this.bumpCatalog(flow);
    }
    return resolved;
  }

  async list(limit: number): Promise<QuestionLog[]> {
    return [...this.logs.values()]
      .sort((left, right) => right.askedAt.localeCompare(left.askedAt))
      .slice(0, limit);
  }

  async reset(): Promise<void> {
    this.logs.clear();
    this.gapCatalogRevision.clear();
  }

  async listGapCandidates(limit: number): Promise<GapCandidate[]> {
    // Group by (flowId, summary) so the same gap surfaced under two flows yields
    // two candidates — each clusters and drafts within its own flow. The flowId
    // is folded into the key, space-separated (flow IDs are slugs with no spaces,
    // so the key can't be ambiguous).
    const groups = new Map<string, { summary: string; flowId?: string; logs: QuestionLog[] }>();
    for (const log of this.logs.values()) {
      if (log.confidence !== "low" && !log.manualGap) {
        continue;
      }

      const summaries = new Set((log.gaps ?? []).filter((gap) => !gap.resolvedAt).map((gap) => gap.summary));
      for (const summary of summaries) {
        const key = `${log.flowId ?? ""} ${summary}`;
        const group = groups.get(key) ?? { summary, flowId: log.flowId, logs: [] };
        group.logs.push(log);
        groups.set(key, group);
      }
    }

    return [...groups.values()]
      .map(({ summary, flowId, logs }) => ({
        summary,
        questionIds: logs.map((log) => log.id),
        count: logs.length,
        latestAskedAt: logs.map((log) => log.askedAt).sort().at(-1) ?? new Date(0).toISOString(),
        confidence: "low" as const,
        ...(flowId ? { flowId } : {})
      }))
      .sort((left, right) => right.count - left.count || right.latestAskedAt.localeCompare(left.latestAskedAt))
      .slice(0, limit);
  }
}
