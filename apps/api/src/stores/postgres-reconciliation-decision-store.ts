import pg from "pg";
import type {
  NewReconciliationDecision,
  ReconciliationDecisionRecord,
  ReconciliationDecisionStore
} from "./reconciliation-decision-store.js";

const { Pool } = pg;

export class PostgresReconciliationDecisionStore implements ReconciliationDecisionStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async record(input: NewReconciliationDecision): Promise<ReconciliationDecisionRecord> {
    const result = await this.pool.query<DecisionRow>(
      `
        INSERT INTO reconciliation_decisions (flow_id, kind, rationale, confirmed, applied, cluster_ids)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [input.flowId ?? null, input.kind, input.rationale, input.confirmed, input.applied, input.clusterIds]
    );
    return mapRow(result.rows[0]);
  }

  async list(limit: number): Promise<ReconciliationDecisionRecord[]> {
    const result = await this.pool.query<DecisionRow>(
      "SELECT * FROM reconciliation_decisions ORDER BY created_at DESC, id DESC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapRow);
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM reconciliation_decisions");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface DecisionRow {
  id: string;
  flow_id: string | null;
  kind: "merge" | "split";
  rationale: string;
  confirmed: boolean;
  applied: boolean;
  cluster_ids: string[];
  created_at: Date;
}

function mapRow(row: DecisionRow): ReconciliationDecisionRecord {
  return {
    id: row.id,
    flowId: row.flow_id ?? undefined,
    kind: row.kind,
    rationale: row.rationale,
    confirmed: row.confirmed,
    applied: row.applied,
    clusterIds: row.cluster_ids,
    createdAt: row.created_at.toISOString()
  };
}
