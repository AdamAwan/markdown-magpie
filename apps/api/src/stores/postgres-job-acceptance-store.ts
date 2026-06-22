import pg from "pg";
import type { JobAcceptanceStore } from "./job-acceptance-store.js";

const { Pool } = pg;

export class PostgresJobAcceptanceStore implements JobAcceptanceStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async accept(jobId: string): Promise<string> {
    const result = await this.pool.query<{ accepted_at: Date }>(
      `INSERT INTO job_failure_acceptances (job_id)
       VALUES ($1)
       ON CONFLICT (job_id) DO UPDATE SET job_id = EXCLUDED.job_id
       RETURNING accepted_at`,
      [jobId]
    );
    return result.rows[0].accepted_at.toISOString();
  }

  async getMany(jobIds: string[]): Promise<Map<string, string>> {
    if (jobIds.length === 0) return new Map();
    const result = await this.pool.query<{ job_id: string; accepted_at: Date }>(
      "SELECT job_id, accepted_at FROM job_failure_acceptances WHERE job_id = ANY($1::text[])",
      [jobIds]
    );
    return new Map(result.rows.map((row) => [row.job_id, row.accepted_at.toISOString()]));
  }

  async clear(jobId: string): Promise<void> {
    await this.pool.query("DELETE FROM job_failure_acceptances WHERE job_id = $1", [jobId]);
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM job_failure_acceptances");
  }
}
