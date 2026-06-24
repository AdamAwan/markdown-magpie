import { randomUUID } from "node:crypto";
import pg from "pg";
import type { PatrolRun, VerifyFinding } from "@magpie/core";
import type { PatrolCursorEntry, PatrolRunInput, PatrolStore } from "./patrol-store.js";

const { Pool } = pg;

// patrol_cursor.flow_id is NOT NULL with a "" default so the composite primary key
// dedupes the default-flow row (a NULL would not be deduped by ON CONFLICT).
function cursorFlowId(flowId: string | undefined): string {
  return flowId ?? "";
}

// patrol_runs.flow_id is nullable (the default flow stores NULL).
function runFlowId(flowId: string | undefined): string | null {
  return flowId ?? null;
}

export class PostgresPatrolStore implements PatrolStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async listCursor(flowId: string | undefined): Promise<PatrolCursorEntry[]> {
    const result = await this.pool.query<{ doc_path: string; last_checked_at: Date }>(
      "SELECT doc_path, last_checked_at FROM patrol_cursor WHERE flow_id = $1",
      [cursorFlowId(flowId)]
    );
    return result.rows.map((row) => ({
      docPath: row.doc_path,
      lastCheckedAt: row.last_checked_at.toISOString()
    }));
  }

  async stampChecked(flowId: string | undefined, docPaths: string[]): Promise<void> {
    if (docPaths.length === 0) {
      return;
    }
    // One statement: upsert every selected doc to now(). unnest expands the path
    // array into rows; ON CONFLICT advances the existing row's timestamp.
    await this.pool.query(
      `
        INSERT INTO patrol_cursor (flow_id, doc_path, last_checked_at)
        SELECT $1, doc_path, now() FROM unnest($2::text[]) AS doc_path
        ON CONFLICT (flow_id, doc_path) DO UPDATE SET last_checked_at = EXCLUDED.last_checked_at
      `,
      [cursorFlowId(flowId), docPaths]
    );
  }

  async createRun(input: PatrolRunInput): Promise<PatrolRun> {
    const id = randomUUID();
    const result = await this.pool.query<PatrolRunRow>(
      `
        INSERT INTO patrol_runs (id, flow_id, trigger, universe_count, selected_count, selected, findings)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [
        id,
        runFlowId(input.flowId),
        input.trigger,
        input.universeCount,
        input.selectedCount,
        JSON.stringify(input.selected),
        JSON.stringify(input.findings ?? [])
      ]
    );
    return mapRunRow(result.rows[0]);
  }

  async listRuns(limit: number): Promise<PatrolRun[]> {
    const result = await this.pool.query<PatrolRunRow>(
      "SELECT * FROM patrol_runs ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapRunRow);
  }

  async getRun(id: string): Promise<PatrolRun | undefined> {
    const result = await this.pool.query<PatrolRunRow>("SELECT * FROM patrol_runs WHERE id = $1", [id]);
    return result.rows[0] ? mapRunRow(result.rows[0]) : undefined;
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM patrol_runs");
      await client.query("DELETE FROM patrol_cursor");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface PatrolRunRow {
  id: string;
  flow_id: string | null;
  trigger: PatrolRun["trigger"];
  universe_count: number;
  selected_count: number;
  selected: string[];
  findings: VerifyFinding[];
  created_at: Date;
}

function mapRunRow(row: PatrolRunRow): PatrolRun {
  return {
    id: row.id,
    flowId: row.flow_id ?? undefined,
    trigger: row.trigger,
    universeCount: row.universe_count,
    selectedCount: row.selected_count,
    selected: row.selected,
    findings: row.findings ?? [],
    createdAt: row.created_at.toISOString()
  };
}
