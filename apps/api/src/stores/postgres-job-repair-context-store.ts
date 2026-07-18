import pg from "pg";
import type { JobType } from "@magpie/jobs";
import type { JobRepairContextInput, JobRepairContextRow, JobRepairContextStore } from "./job-repair-context-store.js";

interface RepairContextDbRow {
  job_id: string;
  target_type: string;
  prior_output: unknown;
  issues: unknown;
  attempt: number;
  created_at: Date;
}

// Postgres-backed repair-context store (#288d). One row per repairing job id
// (see migration 0059_job_repair_context.sql). put() upserts so a replayed
// completion never duplicates a row; the presence of a row bounds repair to
// exactly one attempt.
export class PostgresJobRepairContextStore implements JobRepairContextStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(jobId: string): Promise<JobRepairContextRow | undefined> {
    const result = await this.pool.query<RepairContextDbRow>(
      `SELECT job_id, target_type, prior_output, issues, attempt, created_at
         FROM job_repair_contexts
        WHERE job_id = $1`,
      [jobId]
    );
    const row = result.rows[0];
    return row ? toRow(row) : undefined;
  }

  async put(row: JobRepairContextInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO job_repair_contexts (job_id, target_type, prior_output, issues, attempt)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       ON CONFLICT (job_id) DO UPDATE
         SET target_type = EXCLUDED.target_type,
             prior_output = EXCLUDED.prior_output,
             issues = EXCLUDED.issues,
             attempt = EXCLUDED.attempt`,
      [row.jobId, row.targetType, JSON.stringify(row.priorOutput ?? null), JSON.stringify(row.issues), row.attempt]
    );
  }

  async delete(jobId: string): Promise<void> {
    await this.pool.query("DELETE FROM job_repair_contexts WHERE job_id = $1", [jobId]);
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM job_repair_contexts");
  }
}

function toRow(row: RepairContextDbRow): JobRepairContextRow {
  return {
    jobId: row.job_id,
    targetType: row.target_type as JobType,
    priorOutput: row.prior_output,
    issues: Array.isArray(row.issues) ? (row.issues as Array<{ path: string; message: string }>) : [],
    attempt: row.attempt,
    createdAt: row.created_at.toISOString()
  };
}
