import { randomUUID } from "node:crypto";
import type { GapCandidate, QuestionFeedback, QuestionLog, QuestionLogInput, QuestionLogUpdateInput } from "@magpie/core";

export interface QuestionLogStore {
  record(input: QuestionLogInput): Promise<QuestionLog>;
  updateAnswer(id: string, input: QuestionLogUpdateInput): Promise<QuestionLog | undefined>;
  recordFeedback(id: string, feedback: QuestionFeedback): Promise<QuestionLog | undefined>;
  recordManualGap(id: string, summary?: string): Promise<QuestionLog | undefined>;
  clearManualGap(id: string): Promise<QuestionLog | undefined>;
  get(id: string): Promise<QuestionLog | undefined>;
  list(limit: number): Promise<QuestionLog[]>;
  listGapCandidates(limit: number): Promise<GapCandidate[]>;
  reset(): Promise<void>;
}

export class InMemoryQuestionLogStore implements QuestionLogStore {
  private readonly logs = new Map<string, QuestionLog>();

  async record(input: QuestionLogInput): Promise<QuestionLog> {
    const log: QuestionLog = {
      id: randomUUID(),
      question: input.question,
      executionMode: input.executionMode,
      chatProvider: input.chatProvider,
      confidence: input.answer?.confidence ?? "unknown",
      retrievedSectionIds: input.retrievedSectionIds,
      answer: input.answer,
      gapSummary: input.answer?.gap?.summary,
      askedAt: new Date().toISOString()
    };

    this.logs.set(log.id, log);
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

    const updated: QuestionLog = {
      ...existing,
      chatProvider: input.chatProvider ?? existing.chatProvider,
      confidence: input.answer.confidence,
      retrievedSectionIds: input.answer.citations.map((citation) => citation.sectionId),
      answer: input.answer,
      gapSummary: input.answer.gap?.summary
    };

    this.logs.set(id, updated);
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
    const updated: QuestionLog = {
      ...existing,
      manualGap: true,
      manualGapAt: new Date().toISOString(),
      gapSummary: trimmed || existing.gapSummary || existing.question
    };

    this.logs.set(id, updated);
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
      manualGapAt: undefined
    };

    this.logs.set(id, updated);
    return updated;
  }

  async list(limit: number): Promise<QuestionLog[]> {
    return [...this.logs.values()]
      .sort((left, right) => right.askedAt.localeCompare(left.askedAt))
      .slice(0, limit);
  }

  async reset(): Promise<void> {
    this.logs.clear();
  }

  async listGapCandidates(limit: number): Promise<GapCandidate[]> {
    const groups = new Map<string, QuestionLog[]>();
    for (const log of this.logs.values()) {
      const summary = log.gapSummary;
      if (!summary || (log.confidence !== "low" && !log.manualGap)) {
        continue;
      }

      groups.set(summary, [...(groups.get(summary) ?? []), log]);
    }

    return [...groups.entries()]
      .map(([summary, logs]) => ({
        summary,
        questionIds: logs.map((log) => log.id),
        count: logs.length,
        latestAskedAt: logs.map((log) => log.askedAt).sort().at(-1) ?? new Date(0).toISOString(),
        confidence: "low" as const
      }))
      .sort((left, right) => right.count - left.count || right.latestAskedAt.localeCompare(left.latestAskedAt))
      .slice(0, limit);
  }
}
