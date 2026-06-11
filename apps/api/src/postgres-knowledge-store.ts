import pg from "pg";
import type { DocumentSection, KnowledgeDocument } from "@magpie/core";
import type { IndexedRepositorySummary, KnowledgePersistence } from "./knowledge-index.js";

const { Pool } = pg;

export class PostgresKnowledgeStore implements KnowledgePersistence {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async saveIndexedRepository(
    summary: IndexedRepositorySummary,
    documents: KnowledgeDocument[],
    sections: DocumentSection[]
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO repositories (id, name, remote_url, default_branch, local_path, provider)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO UPDATE
          SET name = EXCLUDED.name,
              remote_url = EXCLUDED.remote_url,
              default_branch = EXCLUDED.default_branch,
              local_path = EXCLUDED.local_path,
              provider = EXCLUDED.provider
        `,
        [
          summary.repository.id,
          summary.repository.name,
          summary.repository.remoteUrl ?? null,
          summary.repository.defaultBranch,
          summary.repository.localPath,
          summary.repository.provider
        ]
      );

      for (const document of documents) {
        await client.query(
          `
            INSERT INTO documents (
              id, repository_id, path, commit_sha, title, owner, status,
              last_verified, review_cycle_days, content, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
            ON CONFLICT (repository_id, path) DO UPDATE
            SET commit_sha = EXCLUDED.commit_sha,
                title = EXCLUDED.title,
                owner = EXCLUDED.owner,
                status = EXCLUDED.status,
                last_verified = EXCLUDED.last_verified,
                review_cycle_days = EXCLUDED.review_cycle_days,
                content = EXCLUDED.content,
                updated_at = now()
          `,
          [
            document.id,
            document.repositoryId,
            document.path,
            document.commitSha ?? summary.commitSha ?? null,
            document.metadata.title,
            document.metadata.owner ?? null,
            document.metadata.status,
            document.metadata.lastVerified ?? null,
            document.metadata.reviewCycleDays ?? null,
            document.content
          ]
        );

        await client.query("DELETE FROM document_sections WHERE document_id = $1", [document.id]);
      }

      for (const section of sections) {
        await client.query(
          `
            INSERT INTO document_sections (
              id, document_id, path, heading, heading_path, anchor, ordinal, content
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            section.id,
            section.documentId,
            section.path,
            section.heading,
            section.headingPath,
            section.anchor,
            section.ordinal,
            section.content
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
