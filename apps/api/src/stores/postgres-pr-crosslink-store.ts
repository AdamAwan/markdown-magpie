import pg from "pg";
import {
  normalisePair,
  type NewPrCrosslink,
  type PrCrosslinkRecord,
  type PrCrosslinkStore
} from "./pr-crosslink-store.js";

const { Pool } = pg;

export class PostgresPrCrosslinkStore implements PrCrosslinkStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async has(a: string, b: string): Promise<boolean> {
    const { low, high } = normalisePair(a, b);
    const result = await this.pool.query(
      "SELECT 1 FROM pr_crosslinks WHERE proposal_low = $1 AND proposal_high = $2 LIMIT 1",
      [low, high]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async existingPairs(proposalIds: string[]): Promise<Set<string>> {
    const pairs = new Set<string>();
    if (proposalIds.length === 0) {
      return pairs;
    }
    // Both endpoints in the candidate set, so the reconciler can test every
    // pairwise overlap against this set without a per-pair round-trip.
    const result = await this.pool.query<{ proposal_low: string; proposal_high: string }>(
      `
        SELECT proposal_low, proposal_high
        FROM pr_crosslinks
        WHERE proposal_low = ANY($1) AND proposal_high = ANY($1)
      `,
      [proposalIds]
    );
    for (const row of result.rows) {
      pairs.add(`${row.proposal_low}|${row.proposal_high}`);
    }
    return pairs;
  }

  async record(input: NewPrCrosslink): Promise<PrCrosslinkRecord> {
    const { low, high } = normalisePair(input.proposalA, input.proposalB);
    const result = await this.pool.query<CrosslinkRow>(
      `
        INSERT INTO pr_crosslinks (flow_id, proposal_low, proposal_high, targets)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (proposal_low, proposal_high)
          DO UPDATE SET targets = EXCLUDED.targets
        RETURNING *
      `,
      [input.flowId ?? null, low, high, input.targets]
    );
    return mapRow(result.rows[0]);
  }

  async list(limit: number): Promise<PrCrosslinkRecord[]> {
    const result = await this.pool.query<CrosslinkRow>(
      "SELECT * FROM pr_crosslinks ORDER BY linked_at DESC, id DESC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapRow);
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM pr_crosslinks");
  }
}

interface CrosslinkRow {
  id: string;
  flow_id: string | null;
  proposal_low: string;
  proposal_high: string;
  targets: string[];
  linked_at: Date;
}

function mapRow(row: CrosslinkRow): PrCrosslinkRecord {
  return {
    id: row.id,
    flowId: row.flow_id ?? undefined,
    proposalLow: row.proposal_low,
    proposalHigh: row.proposal_high,
    targets: row.targets,
    linkedAt: row.linked_at.toISOString()
  };
}
