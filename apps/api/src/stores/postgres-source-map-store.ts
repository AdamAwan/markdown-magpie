import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SourceMapEntry } from "@magpie/core";
import type { SourceMapStore, SourceMapUpsert } from "./source-map-store.js";
import { nextConsensusCount } from "./source-map-consensus.js";

export class PostgresSourceMapStore implements SourceMapStore {
  constructor(private readonly pool: pg.Pool) {}

  async listBySource(sourceId: string, limit: number): Promise<SourceMapEntry[]> {
    // seq DESC breaks equal-updated_at ties by most-recent write, matching the
    // in-memory store's write-sequence tie-break exactly.
    const result = await this.pool.query<SourceMapEntryRow>(
      "SELECT * FROM source_map_entries WHERE source_id = $1 ORDER BY updated_at DESC, seq DESC LIMIT $2",
      [sourceId, limit]
    );
    return result.rows.map(mapRow);
  }

  async upsert(update: SourceMapUpsert): Promise<SourceMapEntry> {
    // The consensus count is a read-modify-write against the existing row, so
    // it must be computed and written atomically: two source-grounded jobs can
    // complete concurrently and contribute the same (source_id, topic), and a
    // plain SELECT-then-upsert would let both read the same count and lose one
    // agent's increment. A transaction with SELECT ... FOR UPDATE serialises
    // concurrent upserts on the row so each increment is counted (#219).
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existingResult = await client.query<SourceMapEntryRow>(
        "SELECT * FROM source_map_entries WHERE source_id = $1 AND topic = $2 FOR UPDATE",
        [update.sourceId, update.topic]
      );
      const existing = existingResult.rows[0];
      const consensusCount = nextConsensusCount(
        update.paths,
        existing ? { consensusCount: existing.consensus_count, paths: existing.paths } : undefined
      );

      // Latest observation wins wholesale, including observed_sha (an update
      // without a sha — or with an empty one — clears a stale sha rather than
      // keeping it). seq is bumped on replace so a re-touched row wins
      // equal-updated_at ties in write order.
      const result = await client.query<SourceMapEntryRow>(
        `
          INSERT INTO source_map_entries (id, source_id, topic, paths, description, observed_sha, consensus_count)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (source_id, topic) DO UPDATE
            SET paths = EXCLUDED.paths,
                description = EXCLUDED.description,
                observed_sha = EXCLUDED.observed_sha,
                consensus_count = EXCLUDED.consensus_count,
                seq = nextval(pg_get_serial_sequence('source_map_entries', 'seq')),
                updated_at = now()
          RETURNING *
        `,
        [
          randomUUID(),
          update.sourceId,
          update.topic,
          JSON.stringify(update.paths),
          update.description,
          update.observedSha ? update.observedSha : null,
          consensusCount
        ]
      );
      await client.query("COMMIT");
      return mapRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async pruneToLimit(sourceId: string, limit: number): Promise<number> {
    const result = await this.pool.query(
      `
        DELETE FROM source_map_entries
        WHERE source_id = $1
          AND id NOT IN (
            SELECT id FROM source_map_entries
            WHERE source_id = $1
            ORDER BY updated_at DESC, seq DESC
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
  consensus_count: number;
  // Monotonic write counter used only for ORDER BY tie-breaks; pg returns
  // bigint columns as strings. Not part of the SourceMapEntry contract.
  seq: string;
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
    consensusCount: row.consensus_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
