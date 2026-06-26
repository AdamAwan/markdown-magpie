import pg from "pg";
import type { SourceSyncState } from "@magpie/core";
import type { SourceSyncStore } from "./source-sync-store.js";

const { Pool } = pg;

// source_sync_state.flow_id is NOT NULL with a "" default so the composite
// primary key (flow_id, source_id) dedupes the default-flow row (a NULL would
// not be deduped by ON CONFLICT).
function storedFlowId(flowId: string | undefined): string {
  return flowId ?? "";
}

export class PostgresSourceSyncStore implements SourceSyncStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async getState(flowId: string | undefined, sourceId: string): Promise<SourceSyncState | undefined> {
    const result = await this.pool.query<SourceSyncStateRow>(
      "SELECT * FROM source_sync_state WHERE flow_id = $1 AND source_id = $2",
      [storedFlowId(flowId), sourceId]
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
      [storedFlowId(flowId), sourceId, lastSha]
    );
    return mapStateRow(result.rows[0]);
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM source_sync_state");
  }
}

interface SourceSyncStateRow {
  flow_id: string;
  source_id: string;
  last_sha: string;
  last_checked_at: Date | string;
}

function mapStateRow(row: SourceSyncStateRow): SourceSyncState {
  return {
    flowId: row.flow_id || undefined,
    sourceId: row.source_id,
    lastSha: row.last_sha,
    lastCheckedAt: row.last_checked_at instanceof Date ? row.last_checked_at.toISOString() : String(row.last_checked_at)
  };
}
