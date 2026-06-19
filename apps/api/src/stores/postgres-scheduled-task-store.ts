import pg from "pg";
import type { ScheduledTaskSettings } from "@magpie/core";
import { nextRunFor } from "./crunch-store.js";
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
    const nextRunAt = nextRunFor(patch.enabled, patch.cron, new Date()) ?? null;
    const result = await this.pool.query<ScheduledTaskRow>(
      `
        INSERT INTO scheduled_task_settings (task_key, enabled, cron, next_run_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (task_key) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              cron = EXCLUDED.cron,
              next_run_at = EXCLUDED.next_run_at
        RETURNING *
      `,
      [key, patch.enabled, patch.cron, nextRunAt]
    );
    return mapRow(result.rows[0]);
  }

  async touchSchedule(
    key: string,
    lastRunAt: string,
    nextRunAt: string,
    expectedNextRunAt?: string
  ): Promise<ScheduledTaskSettings | undefined> {
    // Only an enabled task ticks, and enabling always inserts the row first, so a
    // plain update is sufficient — no upsert (and so no per-task default cron) needed.
    // When `expectedNextRunAt` is supplied the WHERE clause makes this an atomic
    // compare-and-set: across multiple API instances ticking at the same moment,
    // only the one whose UPDATE matches the still-current next_run_at claims the
    // run. The losers get zero rows back and skip, so the task runs exactly once.
    if (expectedNextRunAt !== undefined) {
      const claimed = await this.pool.query<ScheduledTaskRow>(
        `UPDATE scheduled_task_settings
            SET last_run_at = $2, next_run_at = $3
          WHERE task_key = $1 AND next_run_at = $4::timestamptz
        RETURNING *`,
        [key, lastRunAt, nextRunAt, expectedNextRunAt]
      );
      return claimed.rows[0] ? mapRow(claimed.rows[0]) : undefined;
    }

    const result = await this.pool.query<ScheduledTaskRow>(
      "UPDATE scheduled_task_settings SET last_run_at = $2, next_run_at = $3 WHERE task_key = $1 RETURNING *",
      [key, lastRunAt, nextRunAt]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM scheduled_task_settings");
  }
}

interface ScheduledTaskRow {
  task_key: string;
  enabled: boolean;
  cron: string;
  last_run_at: Date | null;
  next_run_at: Date | null;
}

function mapRow(row: ScheduledTaskRow): ScheduledTaskSettings {
  return {
    key: row.task_key,
    enabled: row.enabled,
    cron: row.cron,
    lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : undefined,
    nextRunAt: row.next_run_at ? row.next_run_at.toISOString() : undefined
  };
}
