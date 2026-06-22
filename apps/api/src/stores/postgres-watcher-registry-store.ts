import pg from "pg";
import type { WatcherView } from "@magpie/core";
import type { WatcherRegistryStore, WatcherTouch } from "./watcher-registry-store.js";

const { Pool } = pg;

export class PostgresWatcherRegistryStore implements WatcherRegistryStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async touch(input: WatcherTouch): Promise<void> {
    // Upsert keyed on the watcher's unique name. capabilities is only known on a
    // claim, so when it is omitted COALESCE keeps the stored value. current_job_id
    // is set while busy and nulled while idle. last_seen_at always advances.
    await this.pool.query(
      `
        INSERT INTO watcher_registrations (name, status, capabilities, current_job_id, last_seen_at)
        VALUES ($1, $2, COALESCE($3::text[], '{}'), $4, now())
        ON CONFLICT (name) DO UPDATE
          SET status = EXCLUDED.status,
              capabilities = COALESCE($3::text[], watcher_registrations.capabilities),
              current_job_id = EXCLUDED.current_job_id,
              last_seen_at = now()
      `,
      [
        input.name,
        input.status,
        input.capabilities ?? null,
        input.status === "busy" ? (input.currentJobId ?? null) : null
      ]
    );
  }

  async list(activeWithinMs: number): Promise<WatcherView[]> {
    // Prune watchers that have fallen silent past the active window, then return
    // those still alive. A crashed watcher therefore disappears once it ages out.
    await this.pool.query(
      "DELETE FROM watcher_registrations WHERE last_seen_at < now() - ($1::double precision * interval '1 millisecond')",
      [activeWithinMs]
    );
    const result = await this.pool.query<WatcherRow>(
      "SELECT * FROM watcher_registrations ORDER BY last_seen_at DESC"
    );
    return result.rows.map(mapRow);
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM watcher_registrations");
  }
}

interface WatcherRow {
  name: string;
  status: string;
  capabilities: string[];
  current_job_id: string | null;
  last_seen_at: Date;
}

function mapRow(row: WatcherRow): WatcherView {
  return {
    name: row.name,
    status: row.status === "busy" ? "busy" : "idle",
    capabilities: row.capabilities,
    ...(row.current_job_id ? { currentJobId: row.current_job_id } : {}),
    lastSeenAt: row.last_seen_at.toISOString()
  };
}
