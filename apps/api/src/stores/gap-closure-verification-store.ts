import { randomUUID } from "node:crypto";
import type pg from "pg";

// One row per (proposal, triggering question) re-ask. The audit trail behind a
// proposal's closure_status and the input to the retry-cap loop guard (count of
// prior 'still_open' rows for a question).
export interface GapClosureVerificationInput {
  proposalId: string;
  gapClusterId?: string;
  questionId: string;
  reaskedQuestionId?: string;
  verdict: "closed" | "still_open";
  confidence: string;
  citedMergedDoc: boolean;
  detail?: string;
}

export interface GapClosureVerificationStore {
  record(input: GapClosureVerificationInput): Promise<void>;
  // How many prior re-asks of this triggering question came back 'still_open'.
  // Drives the retry cap: past the threshold, the gap is flagged for a human
  // instead of auto-redrafting.
  countPriorStillOpen(questionId: string): Promise<number>;
  reset(): Promise<void>;
}

export class InMemoryGapClosureVerificationStore implements GapClosureVerificationStore {
  private readonly rows: Array<GapClosureVerificationInput & { id: string }> = [];

  async record(input: GapClosureVerificationInput): Promise<void> {
    this.rows.push({ ...input, id: randomUUID() });
  }

  async countPriorStillOpen(questionId: string): Promise<number> {
    return this.rows.filter((row) => row.questionId === questionId && row.verdict === "still_open").length;
  }

  async reset(): Promise<void> {
    this.rows.length = 0;
  }
}

export class PostgresGapClosureVerificationStore implements GapClosureVerificationStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(input: GapClosureVerificationInput): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO gap_closure_verification
          (id, proposal_id, gap_cluster_id, question_id, reasked_question_id, verdict, confidence, cited_merged_doc, detail)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        randomUUID(),
        input.proposalId,
        input.gapClusterId ?? null,
        input.questionId,
        input.reaskedQuestionId ?? null,
        input.verdict,
        input.confidence,
        input.citedMergedDoc,
        input.detail ?? null
      ]
    );
  }

  async countPriorStillOpen(questionId: string): Promise<number> {
    const result = await this.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM gap_closure_verification WHERE question_id = $1 AND verdict = 'still_open'",
      [questionId]
    );
    return result.rows[0]?.n ?? 0;
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM gap_closure_verification");
  }
}
