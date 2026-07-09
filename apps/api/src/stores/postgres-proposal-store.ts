import { randomUUID } from "node:crypto";
import pg from "pg";
import { TERMINAL_PROPOSAL_STATUSES } from "@magpie/core";
import type { ChangesetChange, Citation, DraftContext, Proposal, ProvenanceClaim, ReviewDecision } from "@magpie/core";
import type { ProposalInput, ProposalListOptions, ProposalStore } from "./proposal-store.js";

export class PostgresProposalStore implements ProposalStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: ProposalInput): Promise<Proposal> {
    const id = randomUUID();
    const result = await this.pool.query<ProposalRow>(
      `
        INSERT INTO proposals (
          id, title, status, target_path, markdown, evidence, gap_summary,
          triggering_question_ids, rationale, job_id, destination_id, gap_cluster_id,
          draft_context, flow_id, changeset, provenance
        )
        VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint, $12, $13, $14, $15)
        ON CONFLICT (job_id) WHERE job_id IS NOT NULL
        DO UPDATE SET job_id = EXCLUDED.job_id
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
        input.destinationId ?? null,
        input.gapClusterId ?? null,
        input.draftContext ? JSON.stringify(input.draftContext) : null,
        input.flowId ?? null,
        input.changeset ? JSON.stringify(input.changeset) : null,
        input.provenance ? JSON.stringify(input.provenance) : null
      ]
    );

    return mapRow(result.rows[0]);
  }

  async list(limit: number, options?: ProposalListOptions): Promise<Proposal[]> {
    const result = options?.status
      ? await this.pool.query<ProposalRow>(
          "SELECT * FROM proposals WHERE status = $2 ORDER BY created_at DESC LIMIT $1",
          [limit, options.status]
        )
      : await this.pool.query<ProposalRow>(
          // Hide every settled status (merged/rejected/superseded) from the default
          // inbox; <> ALL is true only when status matches none of them.
          "SELECT * FROM proposals WHERE status <> ALL($2) ORDER BY created_at DESC LIMIT $1",
          [limit, [...TERMINAL_PROPOSAL_STATUSES]]
        );
    return result.rows.map(mapRow);
  }

  async get(id: string): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>("SELECT * FROM proposals WHERE id = $1", [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async getByJobId(jobId: string): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>("SELECT * FROM proposals WHERE job_id = $1", [jobId]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async listByClosureStatus(closureStatus: NonNullable<Proposal["closureStatus"]>, limit: number): Promise<Proposal[]> {
    const result = await this.pool.query<ProposalRow>(
      "SELECT * FROM proposals WHERE closure_status = $2 ORDER BY created_at DESC LIMIT $1",
      [limit, closureStatus]
    );
    return result.rows.map(mapRow);
  }

  async getByClusterId(gapClusterId: string): Promise<Proposal | undefined> {
    // Mirror the old list(500).find(): exclude terminal statuses (so a cluster
    // whose only proposal is settled resolves to undefined), newest first.
    const result = await this.pool.query<ProposalRow>(
      `
        SELECT * FROM proposals
        WHERE gap_cluster_id = $1::bigint AND status <> ALL($2)
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [gapClusterId, [...TERMINAL_PROPOSAL_STATUSES]]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async updateStatus(id: string, status: Proposal["status"]): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>(
      `
        UPDATE proposals
        SET status = $2,
            merged_at = CASE WHEN $2 = 'merged' THEN COALESCE(merged_at, now()) ELSE merged_at END
        WHERE id = $1
        RETURNING *
      `,
      [id, status]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async setClosureStatus(
    id: string,
    closureStatus: NonNullable<Proposal["closureStatus"]>
  ): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>(
      "UPDATE proposals SET closure_status = $2 WHERE id = $1 RETURNING *",
      [id, closureStatus]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async recordPublication(
    id: string,
    publication: NonNullable<Proposal["publication"]>
  ): Promise<Proposal | undefined> {
    const status = publication.pullRequestUrl ? "pr-opened" : "branch-pushed";
    const result = await this.pool.query<ProposalRow>(
      "UPDATE proposals SET status = $3, publication = $2 WHERE id = $1 RETURNING *",
      [id, JSON.stringify(publication), status]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async linkCluster(id: string, gapClusterId: string): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>(
      "UPDATE proposals SET gap_cluster_id = $2::bigint WHERE id = $1 RETURNING *",
      [id, gapClusterId]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async updateMarkdown(id: string, markdown: string): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>("UPDATE proposals SET markdown = $2 WHERE id = $1 RETURNING *", [
      id,
      markdown
    ]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async updateChangeset(
    id: string,
    changeset: ChangesetChange[],
    primaryMarkdown: string
  ): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>(
      "UPDATE proposals SET changeset = $2, markdown = $3 WHERE id = $1 RETURNING *",
      [id, JSON.stringify(changeset), primaryMarkdown]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async recordRegeneration(id: string, markdown: string, rationale?: string): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>(
      `
        UPDATE proposals
        SET markdown = $2,
            rationale = COALESCE($3, rationale),
            regeneration_count = regeneration_count + 1
        WHERE id = $1
        RETURNING *
      `,
      [id, markdown, rationale ?? null]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async updateReviewDecision(id: string, reviewDecision: ReviewDecision): Promise<Proposal | undefined> {
    const result = await this.pool.query<ProposalRow>(
      "UPDATE proposals SET review_decision = $2 WHERE id = $1 RETURNING *",
      [id, reviewDecision]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM proposals");
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
  gap_summary: string | null;
  triggering_question_ids: string[];
  rationale: string | null;
  job_id: string | null;
  destination_id: string | null;
  gap_cluster_id: string | null;
  flow_id: string | null;
  changeset: ChangesetChange[] | null;
  publication: Proposal["publication"] | null;
  review_decision: string | null;
  draft_context: DraftContext | null;
  provenance: ProvenanceClaim[] | null;
  created_at: Date;
  merged_at: Date | null;
  closure_status: Proposal["closureStatus"] | null;
  regeneration_count: number;
}

function mapRow(row: ProposalRow): Proposal {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    targetPath: row.target_path,
    markdown: row.markdown,
    evidence: row.evidence ?? [],
    gapSummary: row.gap_summary ?? undefined,
    triggeringQuestionIds: row.triggering_question_ids,
    destinationId: row.destination_id ?? undefined,
    gapClusterId: row.gap_cluster_id ?? undefined,
    flowId: row.flow_id ?? undefined,
    changeset: row.changeset ?? undefined,
    rationale: row.rationale ?? undefined,
    jobId: row.job_id ?? undefined,
    publication: row.publication ?? undefined,
    reviewDecision: (row.review_decision as ReviewDecision | null) ?? undefined,
    draftContext: row.draft_context ?? undefined,
    provenance: row.provenance ?? undefined,
    createdAt: row.created_at.toISOString(),
    mergedAt: row.merged_at?.toISOString(),
    closureStatus: row.closure_status ?? undefined,
    regenerationCount: row.regeneration_count ?? 0
  };
}
