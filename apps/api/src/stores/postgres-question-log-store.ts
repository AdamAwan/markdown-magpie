import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  AnswerResult,
  Confidence,
  GapCandidate,
  QuestionFeedback,
  QuestionGap,
  QuestionGapSource,
  QuestionLog,
  QuestionLogInput,
  QuestionLogUpdateInput
} from "@magpie/core";
import type { QuestionLogStore } from "./question-log-store.js";

const { Pool } = pg;

export class PostgresQuestionLogStore implements QuestionLogStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async record(input: QuestionLogInput): Promise<QuestionLog> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO questions (
            id, question, confidence, answer, execution_mode, chat_provider, flow_id, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          id,
          input.question,
          input.answer?.confidence ?? "unknown",
          input.answer?.answer ?? null,
          input.executionMode,
          input.chatProvider,
          input.flowId ?? null,
          JSON.stringify({
            answer: input.answer ?? null,
            retrievedSectionIds: input.retrievedSectionIds
          })
        ]
      );

      await insertGapRows(client, id, autoGapSummaries(input.answer));

      for (const citation of input.answer?.citations ?? []) {
        await client.query(
          `
            INSERT INTO answer_citations (
              question_id, section_id, document_id, path, heading, anchor, excerpt
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (question_id, section_id) DO UPDATE
            SET document_id = EXCLUDED.document_id,
                path = EXCLUDED.path,
                heading = EXCLUDED.heading,
                anchor = EXCLUDED.anchor,
                excerpt = EXCLUDED.excerpt
          `,
          [
            id,
            citation.sectionId,
            citation.documentId,
            citation.path,
            citation.heading,
            citation.anchor,
            citation.excerpt
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const log = await this.get(id);
    if (!log) {
      throw new Error(`Question log not found after insert: ${id}`);
    }

    return log;
  }

  async get(id: string): Promise<QuestionLog | undefined> {
    const result = await this.pool.query<QuestionRow>("SELECT * FROM questions WHERE id = $1", [id]);
    if (!result.rows[0]) {
      return undefined;
    }

    const gapsByQuestion = await this.loadGaps([id]);
    return mapQuestionRow(result.rows[0], gapsByQuestion.get(id) ?? []);
  }

  async updateAnswer(id: string, input: QuestionLogUpdateInput): Promise<QuestionLog | undefined> {
    const existing = await this.get(id);
    if (!existing) {
      return undefined;
    }

    const metadata = {
      answer: input.answer,
      retrievedSectionIds: input.answer.citations.map((citation) => citation.sectionId)
    };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE questions
          SET confidence = $2,
              answer = $3,
              chat_provider = $4,
              metadata = $5
          WHERE id = $1
        `,
        [
          id,
          input.answer.confidence,
          input.answer.answer,
          input.chatProvider ?? existing.chatProvider,
          JSON.stringify(metadata)
        ]
      );
      // Re-answering replaces auto-detected gaps but preserves any manual flag.
      await client.query("DELETE FROM question_gaps WHERE question_id = $1 AND source = 'auto'", [id]);
      await insertGapRows(client, id, autoGapSummaries(input.answer));
      await client.query("DELETE FROM answer_citations WHERE question_id = $1", [id]);

      for (const citation of input.answer.citations) {
        await client.query(
          `
            INSERT INTO answer_citations (
              question_id, section_id, document_id, path, heading, anchor, excerpt
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            id,
            citation.sectionId,
            citation.documentId,
            citation.path,
            citation.heading,
            citation.anchor,
            citation.excerpt
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.get(id);
  }

  async recordFeedback(id: string, feedback: QuestionFeedback): Promise<QuestionLog | undefined> {
    const result = await this.pool.query(
      `
        UPDATE questions
        SET feedback = $2,
            feedback_at = now()
        WHERE id = $1
      `,
      [id, feedback]
    );

    if (result.rowCount !== 1) {
      return undefined;
    }

    return this.get(id);
  }

  async recordManualGap(id: string, summary?: string): Promise<QuestionLog | undefined> {
    const trimmed = summary?.trim();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
          UPDATE questions
          SET manual_gap = true,
              manual_gap_at = now()
          WHERE id = $1
          RETURNING question
        `,
        [id]
      );

      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }

      // Replace any prior manual gap; auto-detected gaps are left untouched. The
      // summary falls back to the question text when none is supplied.
      const manualSummary = trimmed && trimmed.length > 0 ? trimmed : (result.rows[0] as { question: string }).question;
      await client.query("DELETE FROM question_gaps WHERE question_id = $1 AND source = 'manual'", [id]);
      await insertGapRows(client, id, [manualSummary], "manual");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.get(id);
  }

  async clearManualGap(id: string): Promise<QuestionLog | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
          UPDATE questions
          SET manual_gap = false,
              manual_gap_at = null
          WHERE id = $1
        `,
        [id]
      );

      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }

      // Drop the manual flag's gap; any auto-detected gaps remain candidates.
      await client.query("DELETE FROM question_gaps WHERE question_id = $1 AND source = 'manual'", [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.get(id);
  }

  async list(limit: number): Promise<QuestionLog[]> {
    const result = await this.pool.query<QuestionRow>(
      "SELECT * FROM questions ORDER BY asked_at DESC LIMIT $1",
      [limit]
    );
    const gapsByQuestion = await this.loadGaps(result.rows.map((row) => row.id));
    return result.rows.map((row) => mapQuestionRow(row, gapsByQuestion.get(row.id) ?? []));
  }

  // Loads gap rows for the given questions in one query, grouped by question id.
  private async loadGaps(questionIds: string[]): Promise<Map<string, QuestionGap[]>> {
    const grouped = new Map<string, QuestionGap[]>();
    if (questionIds.length === 0) {
      return grouped;
    }

    const result = await this.pool.query<{
      question_id: string;
      summary: string;
      source: QuestionGapSource;
      resolved_at: Date | null;
      resolved_by_proposal_id: string | null;
    }>(
      `
        SELECT question_id, summary, source, resolved_at, resolved_by_proposal_id
        FROM question_gaps
        WHERE question_id = ANY($1)
        ORDER BY created_at ASC, id ASC
      `,
      [questionIds]
    );

    for (const row of result.rows) {
      const existing = grouped.get(row.question_id) ?? [];
      existing.push({
        summary: row.summary,
        source: row.source,
        resolvedAt: row.resolved_at?.toISOString(),
        resolvedByProposalId: row.resolved_by_proposal_id ?? undefined
      });
      grouped.set(row.question_id, existing);
    }

    return grouped;
  }

  async resolveGaps(questionIds: string[], summaries: string[], proposalId: string): Promise<number> {
    const trimmedSummaries = [...new Set(summaries.map((summary) => summary.trim()).filter((summary) => summary.length > 0))];
    if (questionIds.length === 0 || trimmedSummaries.length === 0) {
      return 0;
    }

    const result = await this.pool.query(
      `
        UPDATE question_gaps
        SET resolved_at = now(), resolved_by_proposal_id = $3
        WHERE question_id = ANY($1)
          AND summary = ANY($2)
          AND resolved_at IS NULL
      `,
      [questionIds, trimmedSummaries, proposalId]
    );

    return result.rowCount ?? 0;
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM answer_citations");
      await client.query("DELETE FROM question_gaps");
      await client.query("DELETE FROM questions");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listGapCandidates(limit: number): Promise<GapCandidate[]> {
    // Cluster across individual gap rows so each distinct gap of a multi-topic
    // question can group with the same gap from other questions. A question with
    // both a 'manual' and an 'auto' row for the same summary is counted once.
    // Group by (summary, flow_id) so the same gap raised under two flows yields
    // two candidates, each clustering and drafting within its own flow. flow_id
    // is coalesced to '' so NULL (un-routed) gaps still group with each other.
    const result = await this.pool.query<GapCandidateRow>(
      `
        SELECT
          summary,
          flow_id,
          array_agg(question_id ORDER BY asked_at DESC) AS question_ids,
          count(*)::int AS count,
          max(asked_at) AS latest_asked_at
        FROM (
          SELECT DISTINCT qg.summary, coalesce(q.flow_id, '') AS flow_id, q.id AS question_id, q.asked_at
          FROM question_gaps qg
          JOIN questions q ON q.id = qg.question_id
          WHERE qg.resolved_at IS NULL AND (q.confidence = 'low' OR q.manual_gap = true)
        ) AS distinct_gaps
        GROUP BY summary, flow_id
        ORDER BY count DESC, latest_asked_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) => ({
      summary: row.summary,
      questionIds: row.question_ids,
      count: row.count,
      latestAskedAt: row.latest_asked_at.toISOString(),
      confidence: "low",
      ...(row.flow_id ? { flowId: row.flow_id } : {})
    }));
  }
}

// Inserts one gap row per summary. Used for both auto-detected gaps (on answer)
// and manual gaps (on flag); the caller picks the source.
async function insertGapRows(
  client: pg.PoolClient,
  questionId: string,
  summaries: string[],
  source: QuestionGapSource = "auto"
): Promise<void> {
  for (const summary of summaries) {
    await client.query(
      "INSERT INTO question_gaps (question_id, summary, source) VALUES ($1, $2, $3)",
      [questionId, summary, source]
    );
  }
}

function autoGapSummaries(answer: AnswerResult | undefined): string[] {
  return (answer?.gaps ?? []).map((gap) => gap.summary).filter((summary) => summary.trim().length > 0);
}

interface QuestionRow {
  id: string;
  question: string;
  confidence: Confidence;
  answer: string | null;
  execution_mode: QuestionLog["executionMode"];
  chat_provider: string;
  flow_id: string | null;
  metadata: {
    answer?: AnswerResult | null;
    retrievedSectionIds?: string[];
  };
  feedback: QuestionFeedback | null;
  feedback_at: Date | null;
  manual_gap: boolean;
  manual_gap_at: Date | null;
  asked_at: Date;
}

interface GapCandidateRow {
  summary: string;
  flow_id: string;
  question_ids: string[];
  count: number;
  latest_asked_at: Date;
}

function mapQuestionRow(row: QuestionRow, gaps: QuestionGap[]): QuestionLog {
  const answer = row.metadata.answer ?? undefined;
  return {
    id: row.id,
    question: row.question,
    executionMode: row.execution_mode,
    chatProvider: row.chat_provider,
    confidence: row.confidence,
    retrievedSectionIds: row.metadata.retrievedSectionIds ?? [],
    answer,
    askedAt: row.asked_at.toISOString(),
    ...(row.flow_id ? { flowId: row.flow_id } : {}),
    feedback: row.feedback ?? undefined,
    feedbackAt: row.feedback_at?.toISOString(),
    gaps,
    manualGap: row.manual_gap,
    manualGapAt: row.manual_gap_at?.toISOString()
  };
}
