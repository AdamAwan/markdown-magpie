import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Citation, Proposal } from "@magpie/core";
import type { ProposalInput, ProposalStore } from "./proposal-store.js";

const { Pool } = pg;

export class PostgresProposalStore implements ProposalStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async create(input: ProposalInput): Promise<Proposal> {
    const id = randomUUID();
    const result = await this.pool.query<ProposalRow>(
      `
        INSERT INTO proposals (
          id, title, status, target_path, markdown, evidence, gap_summary,
          triggering_question_ids, rationale, job_id, destination_id
        )
        VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `,
      [
        id,
        input.title,
        input.targetPath,
        input.markdown,
        JSON.stringify(input.evidence),
        input.gapSummary ?? null,
        input.triggeringQuestionIds ?? [],
        input.rationale,
        input.jobId ?? null,
        input.destinationId ?? null
      ]
    );

    return mapRow(result.rows[0]);
  }

  async list(limit: number): Promise<Proposal[]> {
    const result = await this.pool.query<ProposalRow>(
      "SELECT * FROM proposals ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapRow);
  }

  async get(id: string): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>("SELECT * FROM proposals WHERE id = $1", [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async updateStatus(id: string, status: Proposal["status"]): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>(
      "UPDATE proposals SET status = $2 WHERE id = $1 RETURNING *",
      [id, status]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async recordPublication(id: string, publication: NonNullable<Proposal["publication"]>): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>(
      "UPDATE proposals SET status = 'branch-pushed', publication = $2 WHERE id = $1 RETURNING *",
      [id, JSON.stringify(publication)]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM proposals");
      await client.query("DELETE FROM gap_clusters");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface ProposalRow {
  id: string;
  title: string;
  status: Proposal["status"];
  target_path: string;
  markdown: string;
  evidence: Citation[];
  gap_cluster_id: string | null;
  gap_summary: string | null;
  triggering_question_ids: string[];
  rationale: string | null;
  job_id: string | null;
  destination_id: string | null;
  publication: Proposal["publication"] | null;
  created_at: Date;
}

function mapRow(row: ProposalRow): Proposal {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    targetPath: row.target_path,
    markdown: row.markdown,
    evidence: row.evidence ?? [],
    gapClusterId: row.gap_cluster_id ?? undefined,
    gapSummary: row.gap_summary ?? undefined,
    triggeringQuestionIds: row.triggering_question_ids,
    destinationId: row.destination_id ?? undefined,
    rationale: row.rationale ?? undefined,
    jobId: row.job_id ?? undefined,
    publication: row.publication ?? undefined,
    createdAt: row.created_at.toISOString()
  };
}
