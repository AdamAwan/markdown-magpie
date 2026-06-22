import pg from "pg";
import type { ScheduledTaskSettings } from "@magpie/core";
import type { ScheduledTaskStore } from "./scheduled-task-store.js";

const { Pool } = pg;

export class PostgresScheduledTaskStore implements ScheduledTaskStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async listSettings(): Promise<ScheduledTaskSettings[]> {
    const result = await this.pool.query<ScheduledTaskRow>("SELECT * FROM scheduled_task_settings");
    return result.rows.map(mapRow);
  }

  async getSettings(key: string): Promise<ScheduledTaskSettings | undefined> {
    const result = await this.pool.query<ScheduledTaskRow>(
      "SELECT * FROM scheduled_task_settings WHERE task_key = $1",
      [key]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async updateSettings(key: string, patch: { enabled: boolean; cron: string }): Promise<ScheduledTaskSettings> {
    // last_run_at/next_run_at/running_since columns still exist (dropped in
    // Task 12) but are no longer written or read — pg-boss owns run timing and
    // overlap protection now.
    const result = await this.pool.query<ScheduledTaskRow>(
      `
        INSERT INTO scheduled_task_settings (task_key, enabled, cron)
        VALUES ($1, $2, $3)
        ON CONFLICT (task_key) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              cron = EXCLUDED.cron
        RETURNING *
      `,
      [key, patch.enabled, patch.cron]
    );
    return mapRow(result.rows[0]);
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM scheduled_task_settings");
  }
}

interface ScheduledTaskRow {
  task_key: string;
  enabled: boolean;
  cron: string;
}

function mapRow(row: ScheduledTaskRow): ScheduledTaskSettings {
  return {
    key: row.task_key,
    enabled: row.enabled,
    cron: row.cron
  };
}
