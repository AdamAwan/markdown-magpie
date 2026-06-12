import { randomUUID } from "node:crypto";
import type { GapCandidate, QuestionLog, QuestionLogInput, QuestionLogUpdateInput } from "@magpie/core";

export interface QuestionLogStore {
  record(input: QuestionLogInput): Promise<QuestionLog>;
  updateAnswer(id: string, input: QuestionLogUpdateInput): Promise<QuestionLog | undefined>;
  get(id: string): Promise<QuestionLog | undefined>;
  list(limit: number): Promise<QuestionLog[]>;
  listGapCandidates(limit: number): Promise<GapCandidate[]>;
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
      answer: input.answer
    };

    this.logs.set(id, updated);
    return updated;
  }

  async list(limit: number): Promise<QuestionLog[]> {
    return [...this.logs.values()]
      .sort((left, right) => right.askedAt.localeCompare(left.askedAt))
      .slice(0, limit);
  }

  async listGapCandidates(limit: number): Promise<GapCandidate[]> {
    const groups = new Map<string, QuestionLog[]>();
    for (const log of this.logs.values()) {
      const summary = log.answer?.gap?.summary;
      if (!summary || log.confidence !== "low") {
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
