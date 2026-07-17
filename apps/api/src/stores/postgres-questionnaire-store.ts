import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  Confidence,
  Questionnaire,
  QuestionnaireChangeReason,
  QuestionnaireItem,
  QuestionnaireItemCitation,
  QuestionnaireItemOutcome,
  QuestionnaireItemStatus,
  QuestionnaireSummary
} from "@magpie/core";
import type { QuestionnaireStore } from "./questionnaire-store.js";
import { chunk, valuesClause } from "./sql-bulk.js";
import { toVectorLiteral } from "./vector-literal.js";

const ITEM_INSERT_CHUNK = 500;

interface QuestionnaireRow {
  id: string;
  name: string;
  flow_id: string;
  status: Questionnaire["status"];
  created_at: Date;
}

interface ItemRow {
  id: string;
  questionnaire_id: string;
  position: number;
  question: string;
  status: QuestionnaireItemStatus;
  outcome: QuestionnaireItemOutcome | null;
  answer: string | null;
  confidence: string | null;
  answered_at: Date | null;
  question_log_id: string | null;
  reused_from_item_id: string | null;
  change_reason: QuestionnaireChangeReason | null;
  error: string | null;
  approved_at: Date | null;
  stale_at_approval: boolean;
}

interface CitationRow {
  item_id: string;
  section_id: string;
  content_hash: string;
  path: string;
  heading: string;
  excerpt: string;
}

function mapItem(row: ItemRow, citations: QuestionnaireItemCitation[]): QuestionnaireItem {
  return {
    id: row.id,
    questionnaireId: row.questionnaire_id,
    position: row.position,
    question: row.question,
    status: row.status,
    ...(row.outcome !== null ? { outcome: row.outcome } : {}),
    ...(row.answer !== null ? { answer: row.answer } : {}),
    ...(row.confidence !== null ? { confidence: row.confidence as Confidence } : {}),
    ...(row.answered_at !== null ? { answeredAt: row.answered_at.toISOString() } : {}),
    ...(row.question_log_id !== null ? { questionLogId: row.question_log_id } : {}),
    ...(row.reused_from_item_id !== null ? { reusedFromItemId: row.reused_from_item_id } : {}),
    ...(row.change_reason !== null ? { changeReason: row.change_reason } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.approved_at !== null ? { approvedAt: row.approved_at.toISOString() } : {}),
    staleAtApproval: row.stale_at_approval,
    citations
  };
}

export class PostgresQuestionnaireStore implements QuestionnaireStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: { name: string; flowId: string; questions: string[] }): Promise<Questionnaire> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const id = randomUUID();
      const inserted = await client.query<QuestionnaireRow>(
        "INSERT INTO questionnaires (id, name, flow_id) VALUES ($1, $2, $3) RETURNING *",
        [id, input.name, input.flowId]
      );
      const items = input.questions.map((question, position) => ({
        id: randomUUID(),
        position,
        question
      }));
      for (const batch of chunk(items, ITEM_INSERT_CHUNK)) {
        await client.query(
          `
            INSERT INTO questionnaire_items (id, questionnaire_id, position, question)
            VALUES ${valuesClause(batch.length, 4)}
          `,
          batch.flatMap((item) => [item.id, id, item.position, item.question])
        );
      }
      await client.query("COMMIT");
      const row = inserted.rows[0];
      return {
        id: row.id,
        name: row.name,
        flowId: row.flow_id,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        items: items.map((item) => ({
          id: item.id,
          questionnaireId: id,
          position: item.position,
          question: item.question,
          status: "pending" as const,
          staleAtApproval: false,
          citations: []
        }))
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<Questionnaire | undefined> {
    const questionnaire = await this.pool.query<QuestionnaireRow>("SELECT * FROM questionnaires WHERE id = $1", [id]);
    const row = questionnaire.rows[0];
    if (!row) {
      return undefined;
    }
    const items = await this.pool.query<ItemRow>(
      `
        SELECT id, questionnaire_id, position, question, status, outcome, answer, confidence, answered_at,
               question_log_id, reused_from_item_id, change_reason, error, approved_at, stale_at_approval
        FROM questionnaire_items WHERE questionnaire_id = $1 ORDER BY position ASC
      `,
      [id]
    );
    const citations = await this.loadCitations(items.rows.map((item) => item.id));
    return {
      id: row.id,
      name: row.name,
      flowId: row.flow_id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      items: items.rows.map((item) => mapItem(item, citations.get(item.id) ?? []))
    };
  }

  async list(): Promise<QuestionnaireSummary[]> {
    const result = await this.pool.query<
      QuestionnaireRow & {
        total: number;
        reused: number;
        answered: number;
        pending: number;
        unanswerable: number;
        approved: number;
      }
    >(
      `
        SELECT q.*,
               count(i.id)::int AS total,
               count(i.id) FILTER (WHERE i.outcome = 'reused')::int AS reused,
               count(i.id) FILTER (WHERE i.status = 'answered')::int AS answered,
               count(i.id) FILTER (WHERE i.status IN ('pending', 'answering'))::int AS pending,
               count(i.id) FILTER (WHERE i.status = 'unanswerable')::int AS unanswerable,
               count(i.id) FILTER (WHERE i.status = 'approved')::int AS approved
        FROM questionnaires q
        LEFT JOIN questionnaire_items i ON i.questionnaire_id = q.id
        GROUP BY q.id
        ORDER BY q.created_at DESC
      `
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      flowId: row.flow_id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      counts: {
        total: row.total,
        reused: row.reused,
        answered: row.answered,
        pending: row.pending,
        unanswerable: row.unanswerable,
        approved: row.approved
      }
    }));
  }

  async setItemEmbeddings(items: Array<{ itemId: string; embedding: number[]; model: string }>): Promise<void> {
    for (const { itemId, embedding, model } of items) {
      await this.pool.query(
        "UPDATE questionnaire_items SET question_embedding = $2::vector, embedding_model = $3 WHERE id = $1",
        [itemId, toVectorLiteral(embedding), model]
      );
    }
  }

  async matchApproved(
    flowId: string,
    embedding: number[],
    model: string
  ): Promise<{ item: QuestionnaireItem; similarity: number } | undefined> {
    const result = await this.pool.query<ItemRow & { similarity: number }>(
      `
        SELECT i.id, i.questionnaire_id, i.position, i.question, i.status, i.outcome, i.answer, i.confidence,
               i.answered_at, i.question_log_id, i.reused_from_item_id, i.change_reason, i.error,
               i.approved_at, i.stale_at_approval,
               1 - (i.question_embedding <=> $3::vector) AS similarity
        FROM questionnaire_items i
        JOIN questionnaires q ON q.id = i.questionnaire_id
        WHERE q.flow_id = $1
          AND i.status = 'approved'
          AND i.embedding_model = $2
          AND i.question_embedding IS NOT NULL
        ORDER BY i.question_embedding <=> $3::vector
        LIMIT 1
      `,
      [flowId, model, toVectorLiteral(embedding)]
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    const citations = await this.loadCitations([row.id]);
    return { item: mapItem(row, citations.get(row.id) ?? []), similarity: row.similarity };
  }

  async matchApprovedTopN(
    flowId: string,
    embedding: number[],
    model: string,
    limit: number
  ): Promise<Array<{ item: QuestionnaireItem; similarity: number }>> {
    const result = await this.pool.query<ItemRow & { similarity: number }>(
      `
        SELECT i.id, i.questionnaire_id, i.position, i.question, i.status, i.outcome, i.answer, i.confidence,
               i.answered_at, i.question_log_id, i.reused_from_item_id, i.change_reason, i.error,
               i.approved_at, i.stale_at_approval,
               1 - (i.question_embedding <=> $3::vector) AS similarity
        FROM questionnaire_items i
        JOIN questionnaires q ON q.id = i.questionnaire_id
        WHERE q.flow_id = $1
          AND i.status = 'approved'
          AND i.embedding_model = $2
          AND i.question_embedding IS NOT NULL
        ORDER BY i.question_embedding <=> $3::vector
        LIMIT $4
      `,
      [flowId, model, toVectorLiteral(embedding), limit]
    );
    const citations = await this.loadCitations(result.rows.map((row) => row.id));
    return result.rows.map((row) => ({
      item: mapItem(row, citations.get(row.id) ?? []),
      similarity: row.similarity
    }));
  }

  async setReconcileCandidates(itemId: string, basisItemIds: string[]): Promise<void> {
    await this.pool.query("UPDATE questionnaire_items SET reconcile_candidate_ids = $2 WHERE id = $1", [
      itemId,
      JSON.stringify(basisItemIds)
    ]);
  }

  async reconcileCandidateIds(itemId: string): Promise<string[]> {
    const result = await this.pool.query<{ reconcile_candidate_ids: string[] | null }>(
      "SELECT reconcile_candidate_ids FROM questionnaire_items WHERE id = $1",
      [itemId]
    );
    return result.rows[0]?.reconcile_candidate_ids ?? [];
  }

  async markReused(itemId: string, from: { itemId: string; answer: string; answeredAt: string }): Promise<void> {
    // answered_at carries the ORIGINAL generation time forward — the freshness
    // baseline for future newcomer checks (see the design spec).
    await this.pool.query(
      `
        UPDATE questionnaire_items
        SET status = 'answered', outcome = 'reused', answer = $2, answered_at = $3, reused_from_item_id = $4
        WHERE id = $1
      `,
      [itemId, from.answer, from.answeredAt, from.itemId]
    );
  }

  async markChanged(itemId: string, reason: QuestionnaireChangeReason): Promise<void> {
    await this.pool.query("UPDATE questionnaire_items SET outcome = 'changed', change_reason = $2 WHERE id = $1", [
      itemId,
      JSON.stringify(reason)
    ]);
  }

  async markAnswering(itemId: string, questionLogId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE questionnaire_items
        SET status = 'answering', question_log_id = $2, outcome = coalesce(outcome, 'fresh')
        WHERE id = $1
      `,
      [itemId, questionLogId]
    );
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
    const updated = await this.pool.query<ItemRow>(
      `
        UPDATE questionnaire_items
        SET status = $2, answer = $3, answered_at = $4, confidence = $5,
            outcome = COALESCE($6, outcome), reused_from_item_id = $7
        WHERE question_log_id = $1
        RETURNING *
      `,
      [
        questionLogId,
        result.unanswerable ? "unanswerable" : "answered",
        result.answer,
        result.answeredAt,
        result.confidence,
        result.outcome ?? null,
        result.basisItemIds && result.basisItemIds.length === 1 ? result.basisItemIds[0] : null
      ]
    );
    const row = updated.rows[0];
    if (!row) {
      return undefined;
    }
    await this.replaceCitations(row.id, result.citations);
    // Reconcile basis to exactly what this completion says — a fresh
    // re-answer (no/empty basis) must clear any prior basis rows rather than
    // leaving them stale from an earlier completion. replaceBasis DELETEs
    // unconditionally and only re-INSERTs when the array is non-empty.
    await this.replaceBasis(row.id, result.basisItemIds ?? []);
    return mapItem(row, result.citations);
  }

  async failItem(questionLogId: string, error: string): Promise<QuestionnaireItem | undefined> {
    const updated = await this.pool.query<ItemRow>(
      "UPDATE questionnaire_items SET status = 'unanswerable', error = $2 WHERE question_log_id = $1 RETURNING *",
      [questionLogId, error]
    );
    const row = updated.rows[0];
    return row ? mapItem(row, []) : undefined;
  }

  async itemByQuestionLogId(questionLogId: string): Promise<QuestionnaireItem | undefined> {
    const result = await this.pool.query<ItemRow>("SELECT * FROM questionnaire_items WHERE question_log_id = $1", [
      questionLogId
    ]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    const citations = await this.loadCitations([row.id]);
    return mapItem(row, citations.get(row.id) ?? []);
  }

  async itemById(itemId: string): Promise<QuestionnaireItem | undefined> {
    const result = await this.pool.query<ItemRow>("SELECT * FROM questionnaire_items WHERE id = $1", [itemId]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    const citations = await this.loadCitations([row.id]);
    return mapItem(row, citations.get(row.id) ?? []);
  }

  async nextPending(questionnaireId: string): Promise<QuestionnaireItem | undefined> {
    const result = await this.pool.query<ItemRow>(
      `
        SELECT * FROM questionnaire_items
        WHERE questionnaire_id = $1 AND status = 'pending'
        ORDER BY position ASC LIMIT 1
      `,
      [questionnaireId]
    );
    const row = result.rows[0];
    return row ? mapItem(row, []) : undefined;
  }

  async countAnswering(questionnaireId: string): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM questionnaire_items WHERE questionnaire_id = $1 AND status = 'answering'",
      [questionnaireId]
    );
    return result.rows[0]?.count ?? 0;
  }

  async approveItem(itemId: string, citations: QuestionnaireItemCitation[], staleAtApproval: boolean): Promise<void> {
    await this.pool.query(
      "UPDATE questionnaire_items SET status = 'approved', approved_at = now(), stale_at_approval = $2 WHERE id = $1",
      [itemId, staleAtApproval]
    );
    await this.replaceCitations(itemId, citations);
  }

  async listReusedUnapproved(questionnaireId: string): Promise<QuestionnaireItem[]> {
    const result = await this.pool.query<ItemRow>(
      `
        SELECT * FROM questionnaire_items
        WHERE questionnaire_id = $1 AND outcome = 'reused' AND status = 'answered'
        ORDER BY position ASC
      `,
      [questionnaireId]
    );
    const citations = await this.loadCitations(result.rows.map((row) => row.id));
    return result.rows.map((row) => mapItem(row, citations.get(row.id) ?? []));
  }

  private async loadCitations(itemIds: string[]): Promise<Map<string, QuestionnaireItemCitation[]>> {
    const map = new Map<string, QuestionnaireItemCitation[]>();
    if (itemIds.length === 0) {
      return map;
    }
    const result = await this.pool.query<CitationRow>(
      "SELECT * FROM questionnaire_item_citations WHERE item_id = ANY($1::text[])",
      [itemIds]
    );
    for (const row of result.rows) {
      const bucket = map.get(row.item_id) ?? [];
      bucket.push({
        sectionId: row.section_id,
        contentHash: row.content_hash,
        path: row.path,
        heading: row.heading,
        excerpt: row.excerpt
      });
      map.set(row.item_id, bucket);
    }
    return map;
  }

  private async replaceBasis(itemId: string, basisItemIds: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM questionnaire_item_basis WHERE item_id = $1", [itemId]);
      if (basisItemIds.length > 0) {
        await client.query(
          `
            INSERT INTO questionnaire_item_basis (item_id, basis_item_id)
            VALUES ${valuesClause(basisItemIds.length, 2)}
            ON CONFLICT DO NOTHING
          `,
          basisItemIds.flatMap((basisItemId) => [itemId, basisItemId])
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async replaceCitations(itemId: string, citations: QuestionnaireItemCitation[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM questionnaire_item_citations WHERE item_id = $1", [itemId]);
      if (citations.length > 0) {
        await client.query(
          `
            INSERT INTO questionnaire_item_citations (item_id, section_id, content_hash, path, heading, excerpt)
            VALUES ${valuesClause(citations.length, 6)}
            ON CONFLICT (item_id, section_id) DO UPDATE
            SET content_hash = EXCLUDED.content_hash,
                path = EXCLUDED.path,
                heading = EXCLUDED.heading,
                excerpt = EXCLUDED.excerpt
          `,
          citations.flatMap((citation) => [
            itemId,
            citation.sectionId,
            citation.contentHash,
            citation.path,
            citation.heading,
            citation.excerpt
          ])
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
