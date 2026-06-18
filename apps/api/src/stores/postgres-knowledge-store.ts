import pg from "pg";
import type { DocumentSection, KnowledgeDocument, KnowledgeStatus, RepositoryRef } from "@magpie/core";
import type {
  EmbeddingPersistence,
  IndexedRepositorySummary,
  KnowledgePersistence,
  LoadedKnowledge,
  SectionToEmbed,
  SectionVectorSearch
} from "./knowledge-index.js";

const { Pool } = pg;

export class PostgresKnowledgeStore implements KnowledgePersistence, SectionVectorSearch, EmbeddingPersistence {
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

      // Prune documents (cascading to their sections) for source files that no
      // longer exist in the repository, so a re-index doesn't leave stale docs
      // behind. The incoming set is authoritative for this repository.
      await client.query(
        "DELETE FROM documents WHERE repository_id = $1 AND path <> ALL($2::text[])",
        [summary.repository.id, documents.map((document) => document.path)]
      );

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

  async loadAll(): Promise<LoadedKnowledge> {
    const [repositoryRows, documentRows, sectionRows] = await Promise.all([
      this.pool.query<RepositoryRow>(
        "SELECT id, name, remote_url, default_branch, local_path, provider FROM repositories"
      ),
      this.pool.query<DocumentRow>(
        `
          SELECT id, repository_id, path, commit_sha, title, owner, status,
                 to_char(last_verified, 'YYYY-MM-DD') AS last_verified, review_cycle_days, content
          FROM documents
        `
      ),
      this.pool.query<SectionRow>(
        "SELECT id, document_id, path, heading, heading_path, anchor, ordinal, content FROM document_sections"
      )
    ]);

    const repositories: RepositoryRef[] = repositoryRows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      remoteUrl: row.remote_url ?? undefined,
      defaultBranch: row.default_branch,
      localPath: row.local_path,
      provider: row.provider as RepositoryRef["provider"]
    }));

    const documents: KnowledgeDocument[] = documentRows.rows.map((row) => ({
      id: row.id,
      repositoryId: row.repository_id,
      path: row.path,
      commitSha: row.commit_sha ?? undefined,
      metadata: {
        title: row.title,
        owner: row.owner ?? undefined,
        status: row.status as KnowledgeStatus,
        lastVerified: row.last_verified ?? undefined,
        reviewCycleDays: row.review_cycle_days ?? undefined,
        // tags and relatedDocs are not persisted yet; rehydrate as empty.
        tags: [],
        relatedDocs: []
      },
      content: row.content
    }));

    const sections: DocumentSection[] = sectionRows.rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      path: row.path,
      heading: row.heading,
      headingPath: row.heading_path,
      anchor: row.anchor,
      content: row.content,
      ordinal: row.ordinal
    }));

    return { repositories, documents, sections };
  }

  async searchByEmbedding(
    embedding: number[],
    limit: number,
    repositoryIds?: string[]
  ): Promise<Array<{ id: string; similarity: number }>> {
    const literal = toVectorLiteral(embedding);
    // A null filter ($3) matches every repository; otherwise restrict to the flow's
    // destination via the section -> document -> repository join.
    const repositoryFilter = repositoryIds && repositoryIds.length > 0 ? repositoryIds : null;
    const result = await this.pool.query<{ id: string; similarity: string }>(
      `
        SELECT s.id, 1 - (s.embedding <=> $1::vector) AS similarity
        FROM document_sections s
        JOIN documents d ON d.id = s.document_id
        WHERE s.embedding IS NOT NULL
          AND ($3::text[] IS NULL OR d.repository_id = ANY($3))
        ORDER BY s.embedding <=> $1::vector
        LIMIT $2
      `,
      [literal, limit, repositoryFilter]
    );
    return result.rows.map((row) => ({ id: row.id, similarity: Number(row.similarity) }));
  }

  async listSectionsNeedingEmbedding(limit: number, repositoryId?: string): Promise<SectionToEmbed[]> {
    const result = await this.pool.query<{ id: string; heading: string; content: string }>(
      `
        SELECT s.id, s.heading, s.content
        FROM document_sections s
        JOIN documents d ON d.id = s.document_id
        WHERE s.embedding IS NULL
          AND ($1::text IS NULL OR d.repository_id = $1)
        ORDER BY s.id
        LIMIT $2
      `,
      [repositoryId ?? null, limit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      text: row.heading ? `${row.heading}\n${row.content}` : row.content
    }));
  }

  async countSectionsNeedingEmbedding(repositoryId?: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `
        SELECT count(*) AS count
        FROM document_sections s
        JOIN documents d ON d.id = s.document_id
        WHERE s.embedding IS NULL
          AND ($1::text IS NULL OR d.repository_id = $1)
      `,
      [repositoryId ?? null]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM document_sections");
      await client.query("DELETE FROM documents");
      await client.query("DELETE FROM repositories");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveSectionEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.pool.query("UPDATE document_sections SET embedding = $2::vector WHERE id = $1", [
      id,
      toVectorLiteral(embedding)
    ]);
  }
}

interface RepositoryRow {
  id: string;
  name: string;
  remote_url: string | null;
  default_branch: string;
  local_path: string;
  provider: string;
}

interface DocumentRow {
  id: string;
  repository_id: string;
  path: string;
  commit_sha: string | null;
  title: string;
  owner: string | null;
  status: string;
  last_verified: string | null;
  review_cycle_days: number | null;
  content: string;
}

interface SectionRow {
  id: string;
  document_id: string;
  path: string;
  heading: string;
  heading_path: string[];
  anchor: string;
  ordinal: number;
  content: string;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
