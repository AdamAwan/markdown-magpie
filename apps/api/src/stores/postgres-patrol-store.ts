import pg from "pg";
import type { PatrolCursorEntry, PatrolCursorKind, PatrolStore } from "./patrol-store.js";

// patrol_cursor.flow_id is NOT NULL with a "" default so the composite primary key
// dedupes the default-flow row (a NULL would not be deduped by ON CONFLICT). The
// improve cursor namespaces the flow id so it stays distinct from the fix cursor.
function cursorFlowId(flowId: string | undefined, kind: PatrolCursorKind = "fix"): string {
  const base = flowId ?? "";
  return kind === "fix" ? base : `${kind}:${base}`;
}

export class PostgresPatrolStore implements PatrolStore {
  constructor(private readonly pool: pg.Pool) {}

  async listCursor(flowId: string | undefined, kind: PatrolCursorKind = "fix"): Promise<PatrolCursorEntry[]> {
    const result = await this.pool.query<{ doc_path: string; last_checked_at: Date }>(
      "SELECT doc_path, last_checked_at FROM patrol_cursor WHERE flow_id = $1",
      [cursorFlowId(flowId, kind)]
    );
    return result.rows.map((row) => ({
      docPath: row.doc_path,
      lastCheckedAt: row.last_checked_at.toISOString()
    }));
  }

  async stampChecked(flowId: string | undefined, docPaths: string[], kind: PatrolCursorKind = "fix"): Promise<void> {
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
      [cursorFlowId(flowId, kind), docPaths]
    );
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM patrol_cursor");
  }
}
