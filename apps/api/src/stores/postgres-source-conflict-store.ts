import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SourceConflictPosition } from "@magpie/core";
import {
  conflictFingerprint,
  type SourceConflict,
  type SourceConflictListOptions,
  type SourceConflictStore,
  type SourceConflictUpsert
} from "./source-conflict-store.js";

export class PostgresSourceConflictStore implements SourceConflictStore {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(input: SourceConflictUpsert): Promise<{ conflict: SourceConflict; created: boolean }> {
    const fingerprint = conflictFingerprint(input);
    // The DO UPDATE deliberately touches only the observation fields. Status is
    // never written here: a dismissed conflict that is re-detected must stay
    // dismissed, or the register refills with judgements already made. xmax = 0
    // is Postgres's standard "this row was inserted, not updated" test.
    const result = await this.pool.query<SourceConflictRow & { created: boolean }>(
      `
        INSERT INTO source_conflicts (
          id, flow_id, document_path, anchor, topic, summary, claim, positions, fingerprint
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (fingerprint) DO UPDATE
          SET summary = EXCLUDED.summary,
              positions = EXCLUDED.positions,
              last_seen_at = now(),
              seen_count = source_conflicts.seen_count + 1
        RETURNING *, (xmax = 0) AS created
      `,
      [
        randomUUID(),
        input.flowId ?? null,
        input.documentPath,
        input.anchor,
        input.topic,
        input.summary,
        input.claim,
        JSON.stringify(input.positions),
        fingerprint
      ]
    );
    const row = result.rows[0];
    return { conflict: mapRow(row), created: row.created };
  }

  async listOpenForDocument(flowId: string | undefined, documentPath: string): Promise<SourceConflict[]> {
    const result = await this.pool.query<SourceConflictRow>(
      `
        SELECT * FROM source_conflicts
        WHERE status = 'open'
          AND flow_id IS NOT DISTINCT FROM $1
          AND document_path = $2
        ORDER BY first_seen_at ASC
      `,
      [flowId ?? null, documentPath]
    );
    return result.rows.map(mapRow);
  }

  async listOpenPaths(flowId: string | undefined): Promise<string[]> {
    const result = await this.pool.query<{ document_path: string }>(
      `
        SELECT DISTINCT document_path FROM source_conflicts
        WHERE status = 'open' AND flow_id IS NOT DISTINCT FROM $1
      `,
      [flowId ?? null]
    );
    return result.rows.map((row) => row.document_path);
  }

  async list(options: SourceConflictListOptions): Promise<SourceConflict[]> {
    const result = await this.pool.query<SourceConflictRow>(
      `
        SELECT * FROM source_conflicts
        WHERE ($1::text IS NULL OR flow_id = $1)
          AND ($2::text IS NULL OR status = $2)
        ORDER BY last_seen_at DESC
        LIMIT $3
      `,
      [options.flowId ?? null, options.status ?? null, options.limit]
    );
    return result.rows.map(mapRow);
  }

  async get(id: string): Promise<SourceConflict | undefined> {
    const result = await this.pool.query<SourceConflictRow>("SELECT * FROM source_conflicts WHERE id = $1", [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async resolve(id: string, agreedStatement: string): Promise<SourceConflict | undefined> {
    const result = await this.pool.query<SourceConflictRow>(
      `
        UPDATE source_conflicts
        SET status = 'resolved', agreed_statement = $2, resolved_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [id, agreedStatement]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async dismiss(id: string, note: string): Promise<SourceConflict | undefined> {
    const result = await this.pool.query<SourceConflictRow>(
      `
        UPDATE source_conflicts
        SET status = 'dismissed', dismissal_note = $2, resolved_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [id, note]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async recordAnnotation(id: string, proposalId: string): Promise<SourceConflict | undefined> {
    const result = await this.pool.query<SourceConflictRow>(
      "UPDATE source_conflicts SET annotated_proposal_id = $2 WHERE id = $1 RETURNING *",
      [id, proposalId]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM source_conflicts");
  }
}

interface SourceConflictRow {
  id: string;
  flow_id: string | null;
  document_path: string;
  anchor: string;
  topic: string;
  summary: string;
  claim: string;
  positions: SourceConflictPosition[];
  status: SourceConflict["status"];
  fingerprint: string;
  first_seen_at: Date;
  last_seen_at: Date;
  seen_count: number;
  annotated_proposal_id: string | null;
  resolved_at: Date | null;
  agreed_statement: string | null;
  dismissal_note: string | null;
}

function mapRow(row: SourceConflictRow): SourceConflict {
  return {
    id: row.id,
    flowId: row.flow_id ?? undefined,
    documentPath: row.document_path,
    anchor: row.anchor,
    topic: row.topic,
    summary: row.summary,
    claim: row.claim,
    positions: row.positions,
    status: row.status,
    fingerprint: row.fingerprint,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    seenCount: row.seen_count,
    annotatedProposalId: row.annotated_proposal_id ?? undefined,
    resolvedAt: row.resolved_at?.toISOString(),
    agreedStatement: row.agreed_statement ?? undefined,
    dismissalNote: row.dismissal_note ?? undefined
  };
}
