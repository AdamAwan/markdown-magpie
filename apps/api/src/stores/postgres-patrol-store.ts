import pg from "pg";
import {
  normalizePatrolStamp,
  type PatrolCursorEntry,
  type PatrolCursorKind,
  type PatrolStamp,
  type PatrolStore
} from "./patrol-store.js";

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
    const result = await this.pool.query<{
      doc_path: string;
      last_checked_at: Date;
      content_hash: string | null;
      sources_hash: string | null;
    }>(
      "SELECT doc_path, last_checked_at, content_hash, sources_hash FROM patrol_cursor WHERE flow_id = $1",
      [cursorFlowId(flowId, kind)]
    );
    return result.rows.map((row) => ({
      docPath: row.doc_path,
      lastCheckedAt: row.last_checked_at.toISOString(),
      contentHash: row.content_hash ?? undefined,
      sourcesHash: row.sources_hash ?? undefined
    }));
  }

  async stampChecked(
    flowId: string | undefined,
    stamps: readonly PatrolStamp[],
    kind: PatrolCursorKind = "fix"
  ): Promise<void> {
    if (stamps.length === 0) {
      return;
    }
    const normalized = stamps.map(normalizePatrolStamp);
    const docPaths = normalized.map((stamp) => stamp.docPath);
    const contentHashes = normalized.map((stamp) => stamp.contentHash ?? null);
    const sourcesHashes = normalized.map((stamp) => stamp.sourcesHash ?? null);
    // One statement: upsert every selected doc to now(). unnest expands the three
    // parallel arrays into rows; ON CONFLICT advances the existing row's timestamp.
    // COALESCE keeps the previously recorded hash when this stamp carries none, so a
    // rotate-only stamp never clears the verified state from the last real check.
    await this.pool.query(
      `
        INSERT INTO patrol_cursor (flow_id, doc_path, last_checked_at, content_hash, sources_hash)
        SELECT $1, doc_path, now(), content_hash, sources_hash
        FROM unnest($2::text[], $3::text[], $4::text[]) AS t(doc_path, content_hash, sources_hash)
        ON CONFLICT (flow_id, doc_path) DO UPDATE SET
          last_checked_at = EXCLUDED.last_checked_at,
          content_hash = COALESCE(EXCLUDED.content_hash, patrol_cursor.content_hash),
          sources_hash = COALESCE(EXCLUDED.sources_hash, patrol_cursor.sources_hash)
      `,
      [cursorFlowId(flowId, kind), docPaths, contentHashes, sourcesHashes]
    );
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM patrol_cursor");
  }
}
