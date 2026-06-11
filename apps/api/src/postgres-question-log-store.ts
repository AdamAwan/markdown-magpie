import { randomUUID } from "node:crypto";
import pg from "pg";
import type { AnswerResult, Confidence, GapCandidate, QuestionLog, QuestionLogInput } from "@magpie/core";
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
            id, question, confidence, answer, execution_mode, chat_provider,
            gap_summary, metadata
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
          input.answer?.gap?.summary ?? null,
          JSON.stringify({
            answer: input.answer ?? null,
            retrievedSectionIds: input.retrievedSectionIds
          })
        ]
      );

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
    return result.rows[0] ? mapQuestionRow(result.rows[0]) : undefined;
  }

  async list(limit: number): Promise<QuestionLog[]> {
    const result = await this.pool.query<QuestionRow>(
      "SELECT * FROM questions ORDER BY asked_at DESC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapQuestionRow);
  }

  async listGapCandidates(limit: number): Promise<GapCandidate[]> {
    const result = await this.pool.query<GapCandidateRow>(
      `
        SELECT
          gap_summary,
          array_agg(id ORDER BY asked_at DESC) AS question_ids,
          count(*)::int AS count,
          max(asked_at) AS latest_asked_at
        FROM questions
        WHERE confidence = 'low'
          AND gap_summary IS NOT NULL
        GROUP BY gap_summary
        ORDER BY count DESC, latest_asked_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) => ({
      summary: row.gap_summary,
      questionIds: row.question_ids,
      count: row.count,
      latestAskedAt: row.latest_asked_at.toISOString(),
      confidence: "low"
    }));
  }
}

interface QuestionRow {
  id: string;
  question: string;
  confidence: Confidence;
  answer: string | null;
  execution_mode: QuestionLog["executionMode"];
  chat_provider: string;
  metadata: {
    answer?: AnswerResult | null;
    retrievedSectionIds?: string[];
  };
  asked_at: Date;
}

interface GapCandidateRow {
  gap_summary: string;
  question_ids: string[];
  count: number;
  latest_asked_at: Date;
}

function mapQuestionRow(row: QuestionRow): QuestionLog {
  const answer = row.metadata.answer ?? undefined;
  return {
    id: row.id,
    question: row.question,
    executionMode: row.execution_mode,
    chatProvider: row.chat_provider,
    confidence: row.confidence,
    retrievedSectionIds: row.metadata.retrievedSectionIds ?? [],
    answer,
    askedAt: row.asked_at.toISOString()
  };
}
