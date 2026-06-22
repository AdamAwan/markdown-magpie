import { randomUUID } from "node:crypto";
import pg from "pg";
import type { ChangesetChange, CrunchPlan, ProposalPublication, SourceSyncRun, SourceSyncState } from "@magpie/core";
import type { SourceSyncRunInput, SourceSyncStore } from "./source-sync-store.js";

const { Pool } = pg;

// source_sync_state.flow_id is NOT NULL with a "" default so the composite
// primary key (flow_id, source_id) dedupes the default-flow row (a NULL would
// not be deduped by ON CONFLICT).
function stateFlowId(flowId: string | undefined): string {
  return flowId ?? "";
}

// source_sync_runs.flow_id is nullable (the default flow stores NULL).
function runFlowId(flowId: string | undefined): string | null {
  return flowId ?? null;
}

export class PostgresSourceSyncStore implements SourceSyncStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async getState(flowId: string | undefined, sourceId: string): Promise<SourceSyncState | undefined> {
    const result = await this.pool.query<SourceSyncStateRow>(
      "SELECT * FROM source_sync_state WHERE flow_id = $1 AND source_id = $2",
      [stateFlowId(flowId), sourceId]
    );
    return result.rows[0] ? mapStateRow(result.rows[0]) : undefined;
  }

  async setState(flowId: string | undefined, sourceId: string, lastSha: string): Promise<SourceSyncState> {
    const result = await this.pool.query<SourceSyncStateRow>(
      `
        INSERT INTO source_sync_state (flow_id, source_id, last_sha, last_checked_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (flow_id, source_id) DO UPDATE
          SET last_sha = EXCLUDED.last_sha,
              last_checked_at = EXCLUDED.last_checked_at
        RETURNING *
      `,
      [stateFlowId(flowId), sourceId, lastSha]
    );
    return mapStateRow(result.rows[0]);
  }

  async createRun(input: SourceSyncRunInput): Promise<SourceSyncRun> {
    const id = randomUUID();
    const terminal = input.status !== "running";
    const result = await this.pool.query<SourceSyncRunRow>(
      `
        INSERT INTO source_sync_runs (
          id, flow_id, destination_id, source_id, trigger, status, job_id, plan, changeset, error,
          from_sha, to_sha, changed_file_count, candidate_count, completed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ${terminal ? "now()" : "NULL"})
        RETURNING *
      `,
      [
        id,
        runFlowId(input.flowId),
        input.destinationId ?? null,
        input.sourceId,
        input.trigger,
        input.status,
        input.jobId ?? null,
        input.plan ? JSON.stringify(input.plan) : null,
        input.changeset ? JSON.stringify(input.changeset) : null,
        input.error ?? null,
        input.fromSha ?? null,
        input.toSha,
        input.changedFileCount,
        input.candidateCount
      ]
    );
    return mapRunRow(result.rows[0]);
  }

  async listRuns(limit: number): Promise<SourceSyncRun[]> {
    const result = await this.pool.query<SourceSyncRunRow>(
      "SELECT * FROM source_sync_runs ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapRunRow);
  }

  async getRun(id: string): Promise<SourceSyncRun | undefined> {
    const result = await this.pool.query<SourceSyncRunRow>("SELECT * FROM source_sync_runs WHERE id = $1", [id]);
    return result.rows[0] ? mapRunRow(result.rows[0]) : undefined;
  }

  async getRunByJobId(jobId: string): Promise<SourceSyncRun | undefined> {
    const result = await this.pool.query<SourceSyncRunRow>(
      "SELECT * FROM source_sync_runs WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1",
      [jobId]
    );
    return result.rows[0] ? mapRunRow(result.rows[0]) : undefined;
  }

  async completeRun(id: string, plan: CrunchPlan, changeset: ChangesetChange[]): Promise<SourceSyncRun | undefined> {
    return this.transitionFromRunning(
      "UPDATE source_sync_runs SET status = 'completed', plan = $2, changeset = $3, error = NULL, completed_at = now() WHERE id = $1 AND status = 'running' RETURNING *",
      [id, JSON.stringify(plan), JSON.stringify(changeset)],
      id
    );
  }

  async markSkipped(id: string, plan: CrunchPlan): Promise<SourceSyncRun | undefined> {
    return this.transitionFromRunning(
      "UPDATE source_sync_runs SET status = 'skipped', plan = $2, completed_at = now() WHERE id = $1 AND status = 'running' RETURNING *",
      [id, JSON.stringify(plan)],
      id
    );
  }

  async failRun(id: string, error: string): Promise<SourceSyncRun | undefined> {
    return this.transitionFromRunning(
      "UPDATE source_sync_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1 AND status = 'running' RETURNING *",
      [id, error],
      id
    );
  }

  async recordRunPublication(id: string, publication: ProposalPublication): Promise<SourceSyncRun | undefined> {
    const result = await this.pool.query<SourceSyncRunRow>(
      "UPDATE source_sync_runs SET status = 'published', publication = $2 WHERE id = $1 RETURNING *",
      [id, JSON.stringify(publication)]
    );
    return result.rows[0] ? mapRunRow(result.rows[0]) : undefined;
  }

  // Runs a terminal-transition UPDATE guarded by status = 'running'. When the run is
  // already terminal the UPDATE matches nothing, so fall back to the current row — a
  // re-delivered completion/failure is then an idempotent no-op rather than a regress.
  private async transitionFromRunning(
    sql: string,
    params: unknown[],
    id: string
  ): Promise<SourceSyncRun | undefined> {
    const result = await this.pool.query<SourceSyncRunRow>(sql, params);
    return result.rows[0] ? mapRunRow(result.rows[0]) : this.getRun(id);
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM source_sync_runs");
      await client.query("DELETE FROM source_sync_state");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface SourceSyncStateRow {
  flow_id: string;
  source_id: string;
  last_sha: string;
  last_checked_at: Date;
}

interface SourceSyncRunRow {
  id: string;
  flow_id: string | null;
  destination_id: string | null;
  source_id: string;
  trigger: SourceSyncRun["trigger"];
  status: SourceSyncRun["status"];
  job_id: string | null;
  plan: CrunchPlan | null;
  changeset: ChangesetChange[] | null;
  error: string | null;
  from_sha: string | null;
  to_sha: string;
  changed_file_count: number;
  candidate_count: number;
  publication: ProposalPublication | null;
  created_at: Date;
  completed_at: Date | null;
}

function mapStateRow(row: SourceSyncStateRow): SourceSyncState {
  return {
    flowId: row.flow_id ? row.flow_id : undefined,
    sourceId: row.source_id,
    lastSha: row.last_sha,
    lastCheckedAt: row.last_checked_at.toISOString()
  };
}

function mapRunRow(row: SourceSyncRunRow): SourceSyncRun {
  return {
    id: row.id,
    flowId: row.flow_id ?? undefined,
    destinationId: row.destination_id ?? undefined,
    sourceId: row.source_id,
    trigger: row.trigger,
    status: row.status,
    jobId: row.job_id ?? undefined,
    plan: row.plan ?? undefined,
    changeset: row.changeset ?? undefined,
    error: row.error ?? undefined,
    fromSha: row.from_sha ?? undefined,
    toSha: row.to_sha,
    changedFileCount: row.changed_file_count,
    candidateCount: row.candidate_count,
    publication: row.publication ?? undefined,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : undefined
  };
}
