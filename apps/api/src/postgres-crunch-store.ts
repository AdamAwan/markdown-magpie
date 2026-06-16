import { randomUUID } from "node:crypto";
import pg from "pg";
import type { CrunchPlan, CrunchRun, CrunchSettings, ProposalPublication } from "@magpie/core";
import { DEFAULT_CRUNCH_CRON, nextRunFor, type CrunchRunInput, type CrunchStore } from "./crunch-store.js";

const { Pool } = pg;

// crunch_runs.flow_id is nullable (the default flow stores NULL).
function runFlowId(flowId: string | undefined): string | null {
  return flowId ?? null;
}

// crunch_settings.flow_id is NOT NULL with a "" default so ON CONFLICT (flow_id)
// dedupes the default-flow row (a NULL would not be deduped by ON CONFLICT).
function settingsFlowId(flowId: string | undefined): string {
  return flowId ?? "";
}

export class PostgresCrunchStore implements CrunchStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async createRun(input: CrunchRunInput): Promise<CrunchRun> {
    const id = randomUUID();
    const terminal = input.status === "completed" || input.status === "failed";
    const result = await this.pool.query<CrunchRunRow>(
      `
        INSERT INTO crunch_runs (
          id, flow_id, destination_id, trigger, status, job_id, plan, error, document_count, completed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${terminal ? "now()" : "NULL"})
        RETURNING *
      `,
      [
        id,
        runFlowId(input.flowId),
        input.destinationId ?? null,
        input.trigger,
        input.status,
        input.jobId ?? null,
        input.plan ? JSON.stringify(input.plan) : null,
        input.error ?? null,
        input.documentCount
      ]
    );
    return mapRunRow(result.rows[0]);
  }

  async listRuns(limit: number): Promise<CrunchRun[]> {
    const result = await this.pool.query<CrunchRunRow>(
      "SELECT * FROM crunch_runs ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapRunRow);
  }

  async getRun(id: string): Promise<CrunchRun | undefined> {
    const result = await this.pool.query<CrunchRunRow>("SELECT * FROM crunch_runs WHERE id = $1", [id]);
    return result.rows[0] ? mapRunRow(result.rows[0]) : undefined;
  }

  async getRunByJobId(jobId: string): Promise<CrunchRun | undefined> {
    const result = await this.pool.query<CrunchRunRow>(
      "SELECT * FROM crunch_runs WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1",
      [jobId]
    );
    return result.rows[0] ? mapRunRow(result.rows[0]) : undefined;
  }

  async completeRun(id: string, plan: CrunchPlan): Promise<CrunchRun | undefined> {
    const result = await this.pool.query<CrunchRunRow>(
      "UPDATE crunch_runs SET status = 'completed', plan = $2, error = NULL, completed_at = now() WHERE id = $1 RETURNING *",
      [id, JSON.stringify(plan)]
    );
    return result.rows[0] ? mapRunRow(result.rows[0]) : undefined;
  }

  async failRun(id: string, error: string): Promise<CrunchRun | undefined> {
    const result = await this.pool.query<CrunchRunRow>(
      "UPDATE crunch_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1 RETURNING *",
      [id, error]
    );
    return result.rows[0] ? mapRunRow(result.rows[0]) : undefined;
  }

  async recordRunPublication(id: string, publication: ProposalPublication): Promise<CrunchRun | undefined> {
    const result = await this.pool.query<CrunchRunRow>(
      "UPDATE crunch_runs SET status = 'published', publication = $2 WHERE id = $1 RETURNING *",
      [id, JSON.stringify(publication)]
    );
    return result.rows[0] ? mapRunRow(result.rows[0]) : undefined;
  }

  async listSettings(): Promise<CrunchSettings[]> {
    const result = await this.pool.query<CrunchSettingsRow>("SELECT * FROM crunch_settings");
    return result.rows.map(mapSettingsRow);
  }

  async getSettings(flowId: string | undefined): Promise<CrunchSettings> {
    const result = await this.pool.query<CrunchSettingsRow>(
      "SELECT * FROM crunch_settings WHERE flow_id = $1",
      [settingsFlowId(flowId)]
    );
    return result.rows[0]
      ? mapSettingsRow(result.rows[0])
      : { flowId, enabled: false, cron: DEFAULT_CRUNCH_CRON };
  }

  async updateSettings(
    flowId: string | undefined,
    patch: { enabled: boolean; cron: string }
  ): Promise<CrunchSettings> {
    const nextRunAt = nextRunFor(patch.enabled, patch.cron, new Date()) ?? null;
    const result = await this.pool.query<CrunchSettingsRow>(
      `
        INSERT INTO crunch_settings (flow_id, enabled, cron, next_run_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (flow_id) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              cron = EXCLUDED.cron,
              next_run_at = EXCLUDED.next_run_at
        RETURNING *
      `,
      [settingsFlowId(flowId), patch.enabled, patch.cron, nextRunAt]
    );
    return mapSettingsRow(result.rows[0]);
  }

  async touchSchedule(flowId: string | undefined, lastRunAt: string, nextRunAt: string): Promise<CrunchSettings> {
    const result = await this.pool.query<CrunchSettingsRow>(
      `
        INSERT INTO crunch_settings (flow_id, enabled, cron, last_run_at, next_run_at)
        VALUES ($1, false, $2, $3, $4)
        ON CONFLICT (flow_id) DO UPDATE
          SET last_run_at = EXCLUDED.last_run_at,
              next_run_at = EXCLUDED.next_run_at
        RETURNING *
      `,
      [settingsFlowId(flowId), DEFAULT_CRUNCH_CRON, lastRunAt, nextRunAt]
    );
    return mapSettingsRow(result.rows[0]);
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM crunch_runs");
      await client.query("DELETE FROM crunch_settings");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface CrunchRunRow {
  id: string;
  flow_id: string | null;
  destination_id: string | null;
  trigger: CrunchRun["trigger"];
  status: CrunchRun["status"];
  job_id: string | null;
  plan: CrunchPlan | null;
  error: string | null;
  document_count: number;
  publication: ProposalPublication | null;
  created_at: Date;
  completed_at: Date | null;
}

interface CrunchSettingsRow {
  flow_id: string;
  enabled: boolean;
  cron: string;
  last_run_at: Date | null;
  next_run_at: Date | null;
}

function mapRunRow(row: CrunchRunRow): CrunchRun {
  return {
    id: row.id,
    flowId: row.flow_id ?? undefined,
    destinationId: row.destination_id ?? undefined,
    trigger: row.trigger,
    status: row.status,
    jobId: row.job_id ?? undefined,
    plan: row.plan ?? undefined,
    error: row.error ?? undefined,
    documentCount: row.document_count,
    publication: row.publication ?? undefined,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : undefined
  };
}

function mapSettingsRow(row: CrunchSettingsRow): CrunchSettings {
  return {
    flowId: row.flow_id ? row.flow_id : undefined,
    enabled: row.enabled,
    cron: row.cron,
    lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : undefined,
    nextRunAt: row.next_run_at ? row.next_run_at.toISOString() : undefined
  };
}
