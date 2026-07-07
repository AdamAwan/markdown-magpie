import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SourceMapEntry } from "@magpie/core";
import type { SourceMapStore, SourceMapUpsert } from "./source-map-store.js";

export class PostgresSourceMapStore implements SourceMapStore {
  constructor(private readonly pool: pg.Pool) {}

  async listBySource(sourceId: string, limit: number): Promise<SourceMapEntry[]> {
    const result = await this.pool.query<SourceMapEntryRow>(
      "SELECT * FROM source_map_entries WHERE source_id = $1 ORDER BY updated_at DESC, topic ASC LIMIT $2",
      [sourceId, limit]
    );
    return result.rows.map(mapRow);
  }

  async upsert(update: SourceMapUpsert): Promise<SourceMapEntry> {
    // Latest observation wins wholesale, including observed_sha (an update
    // without a sha clears a stale one rather than keeping it).
    const result = await this.pool.query<SourceMapEntryRow>(
      `
        INSERT INTO source_map_entries (id, source_id, topic, paths, description, observed_sha)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (source_id, topic) DO UPDATE
          SET paths = EXCLUDED.paths,
              description = EXCLUDED.description,
              observed_sha = EXCLUDED.observed_sha,
              updated_at = now()
        RETURNING *
      `,
      [
        randomUUID(),
        update.sourceId,
        update.topic,
        JSON.stringify(update.paths),
        update.description,
        update.observedSha ?? null
      ]
    );
    return mapRow(result.rows[0]);
  }

  async pruneToLimit(sourceId: string, limit: number): Promise<number> {
    const result = await this.pool.query(
      `
        DELETE FROM source_map_entries
        WHERE source_id = $1
          AND id NOT IN (
            SELECT id FROM source_map_entries
            WHERE source_id = $1
            ORDER BY updated_at DESC, topic ASC
            LIMIT $2
          )
      `,
      [sourceId, limit]
    );
    return result.rowCount ?? 0;
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM source_map_entries");
  }
}

interface SourceMapEntryRow {
  id: string;
  source_id: string;
  topic: string;
  paths: string[];
  description: string;
  observed_sha: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: SourceMapEntryRow): SourceMapEntry {
  return {
    id: row.id,
    sourceId: row.source_id,
    topic: row.topic,
    paths: row.paths,
    description: row.description,
    observedSha: row.observed_sha ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
