import { randomUUID } from "node:crypto";
import pg from "pg";
import type { MaintenanceRun, MaintenanceTaskType, NewMaintenanceRun } from "@magpie/core";
import type { MaintenanceRunStore } from "./maintenance-run-store.js";

const { Pool } = pg;

// maintenance_runs.flow_id is nullable (the default flow stores NULL).
function runFlowId(flowId: string | undefined): string | null {
  return flowId ?? null;
}

export class PostgresMaintenanceRunStore implements MaintenanceRunStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async record(input: NewMaintenanceRun): Promise<MaintenanceRun> {
    const id = randomUUID();
    const terminal = input.status !== "running";
    const result = await this.pool.query<MaintenanceRunRow>(
      `
        INSERT INTO maintenance_runs (
          id, task_type, flow_id, trigger, status, summary, error, details, started_at, completed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${input.startedAt ? "$9" : "now()"}, ${terminal ? "now()" : "NULL"})
        RETURNING *
      `,
      input.startedAt
        ? [
            id,
            input.taskType,
            runFlowId(input.flowId),
            input.trigger,
            input.status,
            input.summary,
            input.error ?? null,
            JSON.stringify(input.details ?? {}),
            input.startedAt
          ]
        : [
            id,
            input.taskType,
            runFlowId(input.flowId),
            input.trigger,
            input.status,
            input.summary,
            input.error ?? null,
            JSON.stringify(input.details ?? {})
          ]
    );
    return mapRow(result.rows[0]);
  }

  async list(filters: { taskType?: MaintenanceTaskType; flowId?: string; limit: number }): Promise<MaintenanceRun[]> {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (filters.taskType) {
      params.push(filters.taskType);
      conditions.push(`task_type = $${params.length}`);
    }
    if (filters.flowId !== undefined) {
      params.push(filters.flowId);
      conditions.push(`flow_id = $${params.length}`);
    }
    params.push(filters.limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<MaintenanceRunRow>(
      `SELECT * FROM maintenance_runs ${where} ORDER BY started_at DESC, id DESC LIMIT $${params.length}`,
      params
    );
    return result.rows.map(mapRow);
  }

  async get(id: string): Promise<MaintenanceRun | undefined> {
    const result = await this.pool.query<MaintenanceRunRow>("SELECT * FROM maintenance_runs WHERE id = $1", [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM maintenance_runs");
  }
}

interface MaintenanceRunRow {
  id: string;
  task_type: string;
  flow_id: string | null;
  trigger: string;
  status: string;
  summary: string;
  error: string | null;
  details: Record<string, unknown> | null;
  started_at: Date;
  completed_at: Date | null;
}

function mapRow(row: MaintenanceRunRow): MaintenanceRun {
  return {
    id: row.id,
    taskType: row.task_type as MaintenanceTaskType,
    ...(row.flow_id ? { flowId: row.flow_id } : {}),
    trigger: row.trigger as MaintenanceRun["trigger"],
    status: row.status as MaintenanceRun["status"],
    summary: row.summary,
    ...(row.error ? { error: row.error } : {}),
    details: row.details ?? {},
    startedAt: row.started_at.toISOString(),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {})
  };
}
