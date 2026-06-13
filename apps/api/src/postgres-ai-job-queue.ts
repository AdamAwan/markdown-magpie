import { randomUUID } from "node:crypto";
import pg from "pg";
import type { AiJob, AiJobQueue, AiJobStatus, AiJobType } from "@magpie/core";
import { DEFAULT_AI_JOB_CLAIM_TIMEOUT_MS } from "./ai-job-queue.js";

const { Pool } = pg;

export class PostgresAiJobQueue implements AiJobQueue {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, private readonly claimTimeoutMs = DEFAULT_AI_JOB_CLAIM_TIMEOUT_MS) {
    this.pool = new Pool({ connectionString });
  }

  async enqueue<TInput>(type: AiJobType, input: TInput): Promise<AiJob<TInput>> {
    const id = randomUUID();
    const result = await this.pool.query<AiJobRow>(
      `
        INSERT INTO ai_jobs (id, type, status, input)
        VALUES ($1, $2, 'pending', $3)
        RETURNING *
      `,
      [id, type, JSON.stringify(input)]
    );

    return mapRow<TInput>(result.rows[0]);
  }

  async claimNext(workerName: string, acceptedTypes: AiJobType[]): Promise<AiJob | undefined> {
    await this.requeueExpiredClaims();

    const result = await this.pool.query<AiJobRow>(
      `
        UPDATE ai_jobs
        SET status = 'claimed',
            claimed_by = $1,
            claimed_at = now(),
            updated_at = now()
        WHERE id = (
          SELECT id
          FROM ai_jobs
          WHERE status = 'pending'
            AND type = ANY($2::text[])
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING *
      `,
      [workerName, acceptedTypes]
    );

    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  private async requeueExpiredClaims(): Promise<void> {
    await this.pool.query(
      `
        UPDATE ai_jobs
        SET status = 'pending',
            claimed_by = NULL,
            claimed_at = NULL,
            updated_at = now()
        WHERE status = 'claimed'
          AND claimed_at IS NOT NULL
          AND claimed_at < now() - ($1::bigint * interval '1 millisecond')
      `,
      [this.claimTimeoutMs]
    );
  }

  async complete<TOutput>(jobId: string, output: TOutput): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE ai_jobs
        SET status = 'completed',
            output = $2,
            error = NULL,
            updated_at = now()
        WHERE id = $1
      `,
      [jobId, JSON.stringify(output)]
    );

    assertUpdated(result.rowCount, jobId);
  }

  async fail(jobId: string, error: string): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE ai_jobs
        SET status = 'failed',
            error = $2,
            updated_at = now()
        WHERE id = $1
      `,
      [jobId, error]
    );

    assertUpdated(result.rowCount, jobId);
  }

  async get(jobId: string): Promise<AiJob | undefined> {
    const result = await this.pool.query<AiJobRow>("SELECT * FROM ai_jobs WHERE id = $1", [jobId]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async list(): Promise<AiJob[]> {
    const result = await this.pool.query<AiJobRow>("SELECT * FROM ai_jobs ORDER BY created_at ASC");
    return result.rows.map((row) => mapRow(row));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface AiJobRow {
  id: string;
  type: AiJobType;
  status: AiJobStatus;
  input: unknown;
  output: unknown | null;
  error: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow<TInput = unknown, TOutput = unknown>(row: AiJobRow): AiJob<TInput, TOutput> {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    input: row.input as TInput,
    output: row.output === null ? undefined : (row.output as TOutput),
    error: row.error ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    claimedAt: row.claimed_at ? row.claimed_at.toISOString() : undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function assertUpdated(rowCount: number | null, jobId: string): void {
  if (rowCount !== 1) {
    throw new Error(`AI job not found: ${jobId}`);
  }
}
