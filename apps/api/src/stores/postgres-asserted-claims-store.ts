import { randomUUID } from "node:crypto";
import pg from "pg";
import type { AssertedClaimKind, AssertedClaimStatus, SourceConflictPosition } from "@magpie/core";
import {
  assertedClaimFingerprint,
  type AssertedClaim,
  type AssertedClaimListOptions,
  type AssertedClaimsStore,
  type AssertedClaimUpsert
} from "./asserted-claims-store.js";

interface AssertedClaimRow {
  id: string;
  flow_id: string | null;
  questionnaire_id: string | null;
  item_id: string | null;
  kind: AssertedClaimKind;
  question: string;
  claim: string;
  positions: SourceConflictPosition[];
  status: AssertedClaimStatus;
  fingerprint: string;
  first_seen_at: Date;
  last_seen_at: Date;
  seen_count: number;
  resolved_at: Date | null;
  resolution_note: string | null;
}

function mapRow(row: AssertedClaimRow): AssertedClaim {
  return {
    id: row.id,
    ...(row.flow_id !== null ? { flowId: row.flow_id } : {}),
    ...(row.questionnaire_id !== null ? { questionnaireId: row.questionnaire_id } : {}),
    ...(row.item_id !== null ? { itemId: row.item_id } : {}),
    kind: row.kind,
    question: row.question,
    claim: row.claim,
    positions: row.positions,
    status: row.status,
    fingerprint: row.fingerprint,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    seenCount: row.seen_count,
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at.toISOString() } : {}),
    ...(row.resolution_note !== null ? { resolutionNote: row.resolution_note } : {})
  };
}

export class PostgresAssertedClaimsStore implements AssertedClaimsStore {
  constructor(private readonly pool: pg.Pool) {}

  async open(input: AssertedClaimUpsert): Promise<{ claim: AssertedClaim; created: boolean }> {
    const fingerprint = assertedClaimFingerprint(input);
    // The DO UPDATE deliberately touches only the observation fields. Status is
    // never written here: a dismissed finding that is re-detected must stay
    // dismissed, or the register refills with judgements a reviewer already
    // made and stops being read. xmax = 0 is Postgres's standard "this row was
    // inserted, not updated" test.
    const result = await this.pool.query<AssertedClaimRow & { created: boolean }>(
      `
        INSERT INTO asserted_claims (
          id, flow_id, questionnaire_id, item_id, kind, question, claim, positions, fingerprint
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (fingerprint) DO UPDATE
          SET positions = EXCLUDED.positions,
              last_seen_at = now(),
              seen_count = asserted_claims.seen_count + 1
        RETURNING *, (xmax = 0) AS created
      `,
      [
        randomUUID(),
        input.flowId ?? null,
        input.questionnaireId ?? null,
        input.itemId ?? null,
        input.kind,
        input.question,
        input.claim,
        JSON.stringify(input.positions),
        fingerprint
      ]
    );
    const row = result.rows[0];
    return { claim: mapRow(row), created: row.created };
  }

  async list(options: AssertedClaimListOptions): Promise<AssertedClaim[]> {
    const result = await this.pool.query<AssertedClaimRow>(
      `
        SELECT * FROM asserted_claims
        WHERE ($1::text IS NULL OR flow_id = $1)
          AND ($2::text IS NULL OR status = $2)
        ORDER BY last_seen_at DESC
        LIMIT $3
      `,
      [options.flowId ?? null, options.status ?? null, options.limit]
    );
    return result.rows.map(mapRow);
  }

  async get(id: string): Promise<AssertedClaim | undefined> {
    const result = await this.pool.query<AssertedClaimRow>("SELECT * FROM asserted_claims WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }

  async openForItem(itemId: string): Promise<AssertedClaim[]> {
    const result = await this.pool.query<AssertedClaimRow>(
      "SELECT * FROM asserted_claims WHERE status = 'open' AND item_id = $1 ORDER BY first_seen_at ASC",
      [itemId]
    );
    return result.rows.map(mapRow);
  }

  async resolve(id: string, note: string): Promise<AssertedClaim | undefined> {
    return this.transition(id, "resolved", note);
  }

  async dismiss(id: string, note: string): Promise<AssertedClaim | undefined> {
    return this.transition(id, "dismissed", note);
  }

  private async transition(id: string, status: AssertedClaimStatus, note: string): Promise<AssertedClaim | undefined> {
    const result = await this.pool.query<AssertedClaimRow>(
      `
        UPDATE asserted_claims
        SET status = $2, resolution_note = $3, resolved_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [id, status, note]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM asserted_claims");
  }
}
