import { randomUUID } from "node:crypto";
import pg from "pg";
import type { KnowledgeChange } from "@magpie/core";
import {
  UNVERSIONED_DEDUPE_WINDOW_MS,
  type KnowledgeChangeRecord,
  type KnowledgeChangeStore
} from "./knowledge-change-store.js";

export class PostgresKnowledgeChangeStore implements KnowledgeChangeStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(entries: KnowledgeChangeRecord[]): Promise<number> {
    if (entries.length === 0) {
      return 0;
    }

    let appended = 0;
    for (const entry of entries) {
      appended += await this.recordOne(entry);
    }
    return appended;
  }

  async listRecent(limit: number): Promise<KnowledgeChange[]> {
    const result = await this.pool.query<KnowledgeChangeRow>(
      "SELECT * FROM knowledge_changes ORDER BY changed_at DESC, id DESC LIMIT $1",
      [limit]
    );
    return result.rows.map(mapRow);
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM knowledge_changes");
  }

  // One append. Entries carrying a commit sha lean on the partial unique index
  // (knowledge_changes_dedupe_idx) with ON CONFLICT DO NOTHING, so two racing
  // re-indexes of the same commit cannot both win. Entries with no sha have no
  // exact key to conflict on — the index deliberately excludes them, since a
  // permanent (document, anchor, kind) key would swallow every later edit — so
  // they are guarded by a short-window NOT EXISTS probe instead.
  private async recordOne(entry: KnowledgeChangeRecord): Promise<number> {
    const values = [
      randomUUID(),
      entry.repositoryId,
      entry.documentId,
      entry.path,
      entry.anchor ?? null,
      entry.heading ?? null,
      entry.kind,
      entry.commitSha ?? null,
      entry.cause,
      entry.proposalId ?? null,
      entry.jobId ?? null,
      entry.sourceId ?? null,
      entry.sourceFromSha ?? null,
      entry.sourceToSha ?? null,
      entry.summary ?? null,
      entry.flowId ?? null
    ];

    const columns = `
      id, repository_id, document_id, path, anchor, heading, kind, commit_sha, cause,
      proposal_id, job_id, source_id, source_from_sha, source_to_sha, summary, flow_id
    `;
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");

    if (entry.commitSha !== undefined) {
      const result = await this.pool.query(
        `INSERT INTO knowledge_changes (${columns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values
      );
      return result.rowCount ?? 0;
    }

    const windowSeconds = UNVERSIONED_DEDUPE_WINDOW_MS / 1000;
    const result = await this.pool.query(
      `
        INSERT INTO knowledge_changes (${columns})
        SELECT ${placeholders}
        WHERE NOT EXISTS (
          SELECT 1 FROM knowledge_changes
          WHERE document_id = $3
            AND anchor IS NOT DISTINCT FROM $5
            AND kind = $7
            AND commit_sha IS NULL
            AND changed_at > now() - make_interval(secs => $${values.length + 1})
        )
      `,
      [...values, windowSeconds]
    );
    return result.rowCount ?? 0;
  }
}

interface KnowledgeChangeRow {
  id: string;
  repository_id: string;
  document_id: string;
  path: string;
  anchor: string | null;
  heading: string | null;
  kind: KnowledgeChange["kind"];
  changed_at: Date;
  commit_sha: string | null;
  cause: KnowledgeChange["cause"];
  proposal_id: string | null;
  job_id: string | null;
  source_id: string | null;
  source_from_sha: string | null;
  source_to_sha: string | null;
  summary: string | null;
  flow_id: string | null;
}

function mapRow(row: KnowledgeChangeRow): KnowledgeChange {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    documentId: row.document_id,
    path: row.path,
    anchor: row.anchor ?? undefined,
    heading: row.heading ?? undefined,
    kind: row.kind,
    changedAt: row.changed_at.toISOString(),
    commitSha: row.commit_sha ?? undefined,
    cause: row.cause,
    proposalId: row.proposal_id ?? undefined,
    jobId: row.job_id ?? undefined,
    sourceId: row.source_id ?? undefined,
    sourceFromSha: row.source_from_sha ?? undefined,
    sourceToSha: row.source_to_sha ?? undefined,
    summary: row.summary ?? undefined,
    flowId: row.flow_id ?? undefined
  };
}
