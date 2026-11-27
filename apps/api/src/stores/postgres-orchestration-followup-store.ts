import pg from "pg";
import type {
  FollowupOrchestrator,
  OrchestrationFollowup,
  OrchestrationFollowupInput,
  OrchestrationFollowupStore
} from "./orchestration-followup-store.js";

interface FollowupDbRow {
  job_id: string;
  orchestrator: FollowupOrchestrator;
  scope_key: string;
  context: unknown;
  status: OrchestrationFollowup["status"];
  result: unknown;
  created_at: Date;
  settled_at: Date | null;
}

const COLUMNS = "job_id, orchestrator, scope_key, context, status, result, created_at, settled_at";

// Postgres-backed continuation state (migration 0070_orchestration_followups.sql).
export class PostgresOrchestrationFollowupStore implements OrchestrationFollowupStore {
  constructor(private readonly pool: pg.Pool) {}

  async register(input: OrchestrationFollowupInput): Promise<OrchestrationFollowup> {
    // ON CONFLICT DO NOTHING keeps the original owner of a reused in-flight job;
    // the follow-up SELECT returns whichever row is now stored.
    await this.pool.query(
      `INSERT INTO orchestration_followups (job_id, orchestrator, scope_key, context)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (job_id) DO NOTHING`,
      [input.jobId, input.orchestrator, input.scopeKey, JSON.stringify(input.context ?? {})]
    );
    const row = await this.get(input.jobId);
    if (!row) {
      throw new Error(`orchestration follow-up ${input.jobId} vanished immediately after registration`);
    }
    return row;
  }

  async get(jobId: string): Promise<OrchestrationFollowup | undefined> {
    const result = await this.pool.query<FollowupDbRow>(
      `SELECT ${COLUMNS} FROM orchestration_followups WHERE job_id = $1`,
      [jobId]
    );
    return result.rows[0] ? toRow(result.rows[0]) : undefined;
  }

  async listByScope(orchestrator: FollowupOrchestrator, scopeKey: string): Promise<OrchestrationFollowup[]> {
    const result = await this.pool.query<FollowupDbRow>(
      `SELECT ${COLUMNS} FROM orchestration_followups
        WHERE orchestrator = $1 AND scope_key = $2
        ORDER BY created_at ASC, job_id ASC`,
      [orchestrator, scopeKey]
    );
    return result.rows.map(toRow);
  }

  async setContext(jobId: string, context: unknown): Promise<void> {
    await this.pool.query("UPDATE orchestration_followups SET context = $2::jsonb WHERE job_id = $1", [
      jobId,
      JSON.stringify(context ?? {})
    ]);
  }

  async settle(jobId: string, result: unknown): Promise<boolean> {
    const updated = await this.pool.query(
      `UPDATE orchestration_followups
          SET status = 'settled', result = $2::jsonb, settled_at = now()
        WHERE job_id = $1 AND status = 'pending'`,
      [jobId, JSON.stringify(result ?? null)]
    );
    return (updated.rowCount ?? 0) > 0;
  }

  async deleteScope(orchestrator: FollowupOrchestrator, scopeKey: string): Promise<void> {
    await this.pool.query("DELETE FROM orchestration_followups WHERE orchestrator = $1 AND scope_key = $2", [
      orchestrator,
      scopeKey
    ]);
  }

  async pruneSettledBefore(before: string): Promise<void> {
    await this.pool.query("DELETE FROM orchestration_followups WHERE status = 'settled' AND settled_at < $1", [before]);
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM orchestration_followups");
  }
}

function toRow(row: FollowupDbRow): OrchestrationFollowup {
  return {
    jobId: row.job_id,
    orchestrator: row.orchestrator,
    scopeKey: row.scope_key,
    context: row.context,
    status: row.status,
    ...(row.result !== null && row.result !== undefined ? { result: row.result } : {}),
    createdAt: row.created_at.toISOString(),
    ...(row.settled_at ? { settledAt: row.settled_at.toISOString() } : {})
  };
}
