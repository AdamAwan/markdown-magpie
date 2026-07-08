import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SourceMapEntry } from "@magpie/core";
import type { SourceMapStore, SourceMapUpsert } from "./source-map-store.js";

// Max consensus count to keep the data model simple.
const MAX_CONSENSUS_COUNT = 5;

// Computes Jaccard similarity of two path sets: |intersection| / |union|.
// Returns a value in [0, 1], where 1.0 means identical sets.
function jaccardSimilarity(paths1: string[], paths2: string[]): number {
  const set1 = new Set(paths1);
  const set2 = new Set(paths2);
  const intersection = [...set1].filter((p) => set2.has(p)).length;
  const union = new Set([...set1, ...set2]).size;
  return union === 0 ? 0 : intersection / union;
}

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
    // Fetch the existing entry to calculate consensus count based on path overlap
    const existingResult = await this.pool.query<SourceMapEntryRow>(
      "SELECT * FROM source_map_entries WHERE source_id = $1 AND topic = $2",
      [update.sourceId, update.topic]
    );

    // Determine consensus count based on path overlap
    let consensusCount = 1;
    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      const similarity = jaccardSimilarity(update.paths, existing.paths);
      // If new paths overlap sufficiently with existing paths, agents agree
      if (similarity > 0.5) {
        consensusCount = Math.min(existing.consensus_count + 1, MAX_CONSENSUS_COUNT);
      } else {
        // Otherwise reset to 1 (contradicting hint)
        consensusCount = 1;
      }
    }

    // Latest observation wins wholesale, including observed_sha (an update
    // without a sha — or with an empty one — clears a stale sha rather than
    // keeping it). seq is bumped on replace so a re-touched row wins
    // equal-updated_at ties in write order. consensus_count is updated based
    // on path similarity to track credibility via agent consensus (#219).
    const result = await this.pool.query<SourceMapEntryRow>(
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
