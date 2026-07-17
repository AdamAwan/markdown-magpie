import { randomUUID } from "node:crypto";
import type {
  Confidence,
  Questionnaire,
  QuestionnaireChangeReason,
  QuestionnaireItem,
  QuestionnaireItemCitation,
  QuestionnaireItemOutcome,
  QuestionnaireSummary
} from "@magpie/core";

// Store contract for questionnaire mode (docs/questionnaires.md). The item
// history is the canonical answer corpus: `matchApproved` searches approved
// items of prior questionnaires in a flow, and approval snapshots citation
// fingerprints so reuse checks survive re-index section churn.
export interface QuestionnaireStore {
  create(input: { name: string; flowId: string; questions: string[] }): Promise<Questionnaire>;
  get(id: string): Promise<Questionnaire | undefined>;
  list(): Promise<QuestionnaireSummary[]>;
  // Persist creation-time (or approval-backfill) embeddings, stamped with the
  // model per the 0052 convention — matching only compares same-model vectors.
  setItemEmbeddings(items: Array<{ itemId: string; embedding: number[]; model: string }>): Promise<void>;
  // Nearest approved prior item in the flow (same embedding model), with its
  // cosine similarity. Threshold is applied by the caller so "no match" is an
  // explicit decision, not a store default.
  matchApproved(
    flowId: string,
    embedding: number[],
    model: string
  ): Promise<{ item: QuestionnaireItem; similarity: number } | undefined>;
  // Top-N nearest approved prior items in the flow (same embedding model),
  // ordered by descending similarity. Feeds the reconciler's candidate set —
  // unlike matchApproved this doesn't stop at the single closest match.
  matchApprovedTopN(
    flowId: string,
    embedding: number[],
    model: string,
    limit: number
  ): Promise<Array<{ item: QuestionnaireItem; similarity: number }>>;
  // Stash the candidate item ids the reconciler was offered, so a later
  // answer_question completion can be primed with the same candidate set.
  setReconcileCandidates(itemId: string, basisItemIds: string[]): Promise<void>;
  reconcileCandidateIds(itemId: string): Promise<string[]>;
  markReused(itemId: string, from: { itemId: string; answer: string; answeredAt: string }): Promise<void>;
  // Records why a matched item could not reuse; the item STAYS pending so the
  // drip re-answers it, and the worksheet explains the wording change.
  markChanged(itemId: string, reason: QuestionnaireChangeReason): Promise<void>;
  markAnswering(itemId: string, questionLogId: string): Promise<void>;
  completeItem(
    questionLogId: string,
    result: {
      answer: string;
      answeredAt: string;
      citations: QuestionnaireItemCitation[];
      unanswerable: boolean;
      confidence: Confidence;
      // Reconciliation verdict + the approved items it drew on. Persisted as
      // the item's outcome/provenance; omitted (fresh, no basis) when the
      // answer wasn't reconciled against prior approved items.
      outcome?: QuestionnaireItemOutcome;
      basisItemIds?: string[];
    }
  ): Promise<QuestionnaireItem | undefined>;
  failItem(questionLogId: string, error: string): Promise<QuestionnaireItem | undefined>;
  itemByQuestionLogId(questionLogId: string): Promise<QuestionnaireItem | undefined>;
  itemById(itemId: string): Promise<QuestionnaireItem | undefined>;
  nextPending(questionnaireId: string): Promise<QuestionnaireItem | undefined>;
  countAnswering(questionnaireId: string): Promise<number>;
  approveItem(itemId: string, citations: QuestionnaireItemCitation[], staleAtApproval: boolean): Promise<void>;
  listReusedUnapproved(questionnaireId: string): Promise<QuestionnaireItem[]>;
}

// Exported (not just for internal use) so tests can assert on
// completion-time provenance (basisItemIds) that QuestionnaireItem doesn't
// expose publicly — completeItem/itemById still declare the narrower
// QuestionnaireItem return type per the store contract.
export interface StoredItem extends QuestionnaireItem {
  embedding?: number[];
  embeddingModel?: string;
  // Candidate ids stashed by the reconciler (mirrors reconcile_candidate_ids).
  reconcileCandidateIds?: string[];
  // Provenance recorded at completion time (mirrors questionnaire_item_basis).
  basisItemIds?: string[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function summarize(questionnaire: Questionnaire): QuestionnaireSummary {
  const counts = { total: 0, reused: 0, answered: 0, pending: 0, unanswerable: 0, approved: 0 };
  for (const item of questionnaire.items) {
    counts.total += 1;
    if (item.outcome === "reused") counts.reused += 1;
    if (item.status === "answered") counts.answered += 1;
    if (item.status === "pending" || item.status === "answering") counts.pending += 1;
    if (item.status === "unanswerable") counts.unanswerable += 1;
    if (item.status === "approved") counts.approved += 1;
  }
  return {
    id: questionnaire.id,
    name: questionnaire.name,
    flowId: questionnaire.flowId,
    status: questionnaire.status,
    createdAt: questionnaire.createdAt,
    counts
  };
}

// In-memory implementation for unit tests and memory-backed deployments.
// Matching computes cosine similarity in JS over the same stored vectors the
// Postgres implementation delegates to pgvector.
export class InMemoryQuestionnaireStore implements QuestionnaireStore {
  private readonly questionnaires = new Map<string, Questionnaire>();
  private readonly items = new Map<string, StoredItem>();

  async create(input: { name: string; flowId: string; questions: string[] }): Promise<Questionnaire> {
    const id = randomUUID();
    const items: StoredItem[] = input.questions.map((question, position) => ({
      id: randomUUID(),
      questionnaireId: id,
      position,
      question,
      status: "pending",
      staleAtApproval: false,
      citations: []
    }));
    const questionnaire: Questionnaire = {
      id,
      name: input.name,
      flowId: input.flowId,
      status: "open",
      createdAt: new Date().toISOString(),
      items
    };
    this.questionnaires.set(id, questionnaire);
    for (const item of items) {
      this.items.set(item.id, item);
    }
    return structuredClone(questionnaire);
  }

  async get(id: string): Promise<Questionnaire | undefined> {
    const questionnaire = this.questionnaires.get(id);
    return questionnaire ? structuredClone(questionnaire) : undefined;
  }

  async list(): Promise<QuestionnaireSummary[]> {
    return [...this.questionnaires.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summarize);
  }

  async setItemEmbeddings(items: Array<{ itemId: string; embedding: number[]; model: string }>): Promise<void> {
    for (const { itemId, embedding, model } of items) {
      const item = this.items.get(itemId);
      if (item) {
        item.embedding = embedding;
        item.embeddingModel = model;
      }
    }
  }

  async matchApproved(
    flowId: string,
    embedding: number[],
    model: string
  ): Promise<{ item: QuestionnaireItem; similarity: number } | undefined> {
    let best: { item: QuestionnaireItem; similarity: number } | undefined;
    for (const item of this.items.values()) {
      const questionnaire = this.questionnaires.get(item.questionnaireId);
      if (!questionnaire || questionnaire.flowId !== flowId) continue;
      if (item.status !== "approved" || !item.embedding || item.embeddingModel !== model) continue;
      const similarity = cosineSimilarity(item.embedding, embedding);
      if (!best || similarity > best.similarity) {
        best = { item: structuredClone(item), similarity };
      }
    }
    return best;
  }

  async matchApprovedTopN(
    flowId: string,
    embedding: number[],
    model: string,
    limit: number
  ): Promise<Array<{ item: QuestionnaireItem; similarity: number }>> {
    const candidates: Array<{ item: QuestionnaireItem; similarity: number }> = [];
    for (const item of this.items.values()) {
      const questionnaire = this.questionnaires.get(item.questionnaireId);
      if (!questionnaire || questionnaire.flowId !== flowId) continue;
      if (item.status !== "approved" || !item.embedding || item.embeddingModel !== model) continue;
      const similarity = cosineSimilarity(item.embedding, embedding);
      candidates.push({ item: structuredClone(item), similarity });
    }
    candidates.sort((a, b) => b.similarity - a.similarity);
    return candidates.slice(0, limit);
  }

  async setReconcileCandidates(itemId: string, basisItemIds: string[]): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) return;
    item.reconcileCandidateIds = basisItemIds;
  }

  async reconcileCandidateIds(itemId: string): Promise<string[]> {
    const item = this.items.get(itemId);
    return item?.reconcileCandidateIds ?? [];
  }

  async markReused(itemId: string, from: { itemId: string; answer: string; answeredAt: string }): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) return;
    item.status = "answered";
    item.outcome = "reused";
    item.answer = from.answer;
    // The ORIGINAL generation time carries forward — the freshness baseline.
    item.answeredAt = from.answeredAt;
    item.reusedFromItemId = from.itemId;
  }

  async markChanged(itemId: string, reason: QuestionnaireChangeReason): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) return;
    item.outcome = "changed";
    item.changeReason = reason;
  }

  async markAnswering(itemId: string, questionLogId: string): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) return;
    item.status = "answering";
    item.questionLogId = questionLogId;
    if (!item.outcome) {
      item.outcome = "fresh";
    }
  }

  async completeItem(
    questionLogId: string,
    result: {
      answer: string;
      answeredAt: string;
      citations: QuestionnaireItemCitation[];
      unanswerable: boolean;
      confidence: Confidence;
      outcome?: QuestionnaireItemOutcome;
      basisItemIds?: string[];
    }
  ): Promise<QuestionnaireItem | undefined> {
    const item = await this.findByLog(questionLogId);
    if (!item) return undefined;
    item.status = result.unanswerable ? "unanswerable" : "answered";
    item.answer = result.answer;
    item.answeredAt = result.answeredAt;
    item.citations = result.citations;
    item.confidence = result.confidence;
    if (result.outcome) {
      item.outcome = result.outcome;
    }
    // Reconcile provenance to exactly what this completion says — a fresh
    // re-answer (no/empty/multi basis) must clear any prior reuse pointer
    // rather than leaving it stale from an earlier completion.
    item.basisItemIds = result.basisItemIds ?? [];
    item.reusedFromItemId = result.basisItemIds && result.basisItemIds.length === 1 ? result.basisItemIds[0] : undefined;
    return structuredClone(item);
  }

  async failItem(questionLogId: string, error: string): Promise<QuestionnaireItem | undefined> {
    const item = await this.findByLog(questionLogId);
    if (!item) return undefined;
    item.status = "unanswerable";
    item.error = error;
    return structuredClone(item);
  }

  async itemByQuestionLogId(questionLogId: string): Promise<QuestionnaireItem | undefined> {
    const item = await this.findByLog(questionLogId);
    return item ? structuredClone(item) : undefined;
  }

  async itemById(itemId: string): Promise<QuestionnaireItem | undefined> {
    const item = this.items.get(itemId);
    return item ? structuredClone(item) : undefined;
  }

  async nextPending(questionnaireId: string): Promise<QuestionnaireItem | undefined> {
    const pending = [...this.items.values()]
      .filter((item) => item.questionnaireId === questionnaireId && item.status === "pending")
      .sort((a, b) => a.position - b.position);
    return pending[0] ? structuredClone(pending[0]) : undefined;
  }

  async countAnswering(questionnaireId: string): Promise<number> {
    return [...this.items.values()].filter(
      (item) => item.questionnaireId === questionnaireId && item.status === "answering"
    ).length;
  }

  async approveItem(itemId: string, citations: QuestionnaireItemCitation[], staleAtApproval: boolean): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) return;
    item.status = "approved";
    item.approvedAt = new Date().toISOString();
    item.citations = citations;
    item.staleAtApproval = staleAtApproval;
  }

  async listReusedUnapproved(questionnaireId: string): Promise<QuestionnaireItem[]> {
    return [...this.items.values()]
      .filter(
        (item) => item.questionnaireId === questionnaireId && item.outcome === "reused" && item.status === "answered"
      )
      .sort((a, b) => a.position - b.position)
      .map((item) => structuredClone(item));
  }

  private async findByLog(questionLogId: string): Promise<StoredItem | undefined> {
    return [...this.items.values()].find((item) => item.questionLogId === questionLogId);
  }
}
