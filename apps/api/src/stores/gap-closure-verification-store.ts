import { randomUUID } from "node:crypto";
import type pg from "pg";

// One row per (proposal, triggering question) re-ask. The audit trail behind a
// proposal's closure_status and the input to the retry-cap loop guard (count of
// distinct prior proposals whose re-ask of a question came back 'still_open',
// scoped to since the question's verification lineage last reset — see
// countPriorStillOpen below).
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

// Local to this file: both the in-memory and Postgres implementations live here
// and the context types the store via the factory's return union (like the other
// stores), so nothing imports this contract by name — keeping it unexported keeps
// the dead-code check (knip) green while still constraining both classes.
interface GapClosureVerificationStore {
  record(input: GapClosureVerificationInput): Promise<void>;
  // How many *distinct proposals* re-asking this triggering question came back
  // 'still_open'. Drives the retry cap: past the threshold, the gap is flagged
  // for a human instead of auto-redrafting.
  //
  // Counts distinct proposal_id (not raw rows) so a job retry that re-records
  // the same proposal's outcome — verify_gap_closure has no idempotency guard
  // and its retries re-run the whole re-ask loop — never inflates the cap; a
  // single logical attempt only ever costs 1 toward it however many times it is
  // retried.
  //
  // `since`, when given (an ISO timestamp), excludes rows recorded at or before
  // it — the caller passes the resolved/dismissed timestamp of the question's
  // prior verification-lineage gap (if any), so a question whose earlier
  // still-open streak was fixed or dismissed by a human starts a fresh budget
  // rather than carrying the old count forever.
  countPriorStillOpen(questionId: string, since?: string): Promise<number>;
  reset(): Promise<void>;
}

export class InMemoryGapClosureVerificationStore implements GapClosureVerificationStore {
  private readonly rows: Array<GapClosureVerificationInput & { id: string; recordedAt: string }> = [];

  async record(input: GapClosureVerificationInput): Promise<void> {
    this.rows.push({ ...input, id: randomUUID(), recordedAt: new Date().toISOString() });
  }

  async countPriorStillOpen(questionId: string, since?: string): Promise<number> {
    const proposalIds = new Set(
      this.rows
        .filter(
          (row) =>
            row.questionId === questionId &&
            row.verdict === "still_open" &&
            (since === undefined || row.recordedAt > since)
        )
        .map((row) => row.proposalId)
    );
    return proposalIds.size;
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

  async countPriorStillOpen(questionId: string, since?: string): Promise<number> {
    const result = await this.pool.query<{ n: number }>(
      `
        SELECT count(DISTINCT proposal_id)::int AS n
        FROM gap_closure_verification
        WHERE question_id = $1
          AND verdict = 'still_open'
          AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
      `,
      [questionId, since ?? null]
    );
    return result.rows[0]?.n ?? 0;
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM gap_closure_verification");
  }
}
