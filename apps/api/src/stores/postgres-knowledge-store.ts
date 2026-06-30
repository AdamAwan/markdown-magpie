import pg from "pg";
import type { DocumentSection, KnowledgeDocument, KnowledgeStatus, RepositoryRef } from "@magpie/core";
import type {
  EmbeddingPersistence,
  IncrementalIndexInput,
  IndexedRepositorySummary,
  KnowledgePersistence,
  LoadedKnowledge,
  LoadedRepository,
  SectionEmbeddingToSave,
  SectionKeywordSearch,
  SectionToEmbed,
  SectionVectorSearch
} from "./knowledge-index.js";
import { chunk, valuesClause } from "./sql-bulk.js";

const { Pool } = pg;

// Bind-parameter budget per statement (Postgres caps at 65535). Documents bind
// 10 params/row and sections 8, so these chunk sizes stay well under the cap.
const DOCUMENT_INSERT_CHUNK = 500;
const SECTION_INSERT_CHUNK = 1000;
// Embedding updates bind 2 params/row (id, embedding); keep chunks well under
// the 65535 bind-parameter cap while still cutting round-trips drastically.
const EMBEDDING_UPDATE_CHUNK = 1000;

export class PostgresKnowledgeStore
  implements KnowledgePersistence, SectionVectorSearch, SectionKeywordSearch, EmbeddingPersistence
{
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
          INSERT INTO repositories (id, name, remote_url, default_branch, local_path, provider, indexed_commit_sha)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE
          SET name = EXCLUDED.name,
              remote_url = EXCLUDED.remote_url,
              default_branch = EXCLUDED.default_branch,
              local_path = EXCLUDED.local_path,
              provider = EXCLUDED.provider,
              indexed_commit_sha = EXCLUDED.indexed_commit_sha
        `,
        [
          summary.repository.id,
          summary.repository.name,
          summary.repository.remoteUrl ?? null,
          summary.repository.defaultBranch,
          summary.repository.localPath,
          summary.repository.provider,
          summary.commitSha ?? null
        ]
      );

      await this.upsertDocuments(client, documents, summary.commitSha);

      // Clear existing sections for the (re)indexed documents in one statement so
      // they can be re-inserted fresh below.
      await client.query("DELETE FROM document_sections WHERE document_id = ANY($1::text[])", [
        documents.map((document) => document.id)
      ]);

      // Prune documents (cascading to their sections) for source files that no
      // longer exist in the repository, so a re-index doesn't leave stale docs
      // behind. The incoming set is authoritative for this repository.
      await client.query(
        "DELETE FROM documents WHERE repository_id = $1 AND path <> ALL($2::text[])",
        [summary.repository.id, documents.map((document) => document.path)]
      );

      await this.insertSections(client, sections);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // Persists a single incremental reindex in one transaction: removes the deleted
  // documents (their sections cascade via the FK), and for each upserted document
  // clears its old sections, upserts the document row, and inserts its fresh
  // sections — then advances the repository's indexed_commit_sha. Unchanged rows
  // are never touched (unlike saveIndexedRepository's whole-repository rewrite).
  async applyIncrementalIndex(input: IncrementalIndexInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      if (input.deletedDocumentIds.length > 0) {
        // document_sections.document_id references documents(id); delete sections
        // first to honour the FK regardless of its ON DELETE behavior.
        await client.query("DELETE FROM document_sections WHERE document_id = ANY($1::text[])", [
          input.deletedDocumentIds
        ]);
        await client.query("DELETE FROM documents WHERE id = ANY($1::text[])", [input.deletedDocumentIds]);
      }

      if (input.upsertedDocuments.length > 0) {
        await this.upsertDocuments(client, input.upsertedDocuments, input.commitSha);

        // Replace each upserted document's sections: drop the old ones, then
        // insert the freshly split set.
        await client.query("DELETE FROM document_sections WHERE document_id = ANY($1::text[])", [
          input.upsertedDocuments.map((document) => document.id)
        ]);
        await this.insertSections(client, input.upsertedSections);
      }

      await client.query("UPDATE repositories SET indexed_commit_sha = $2 WHERE id = $1", [
        input.repository.id,
        input.commitSha ?? null
      ]);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // Upserts documents in batched multi-row INSERTs (one query per chunk rather
  // than one per row, which on a large repo meant thousands of serial round-trips
  // inside the open transaction). `fallbackCommitSha` fills commit_sha for any
  // document that doesn't carry its own. Shared by the full and incremental save
  // paths so a column change can't diverge between them. Runs on the caller's
  // client so it participates in the caller's transaction.
  private async upsertDocuments(
    client: pg.PoolClient,
    documents: KnowledgeDocument[],
    fallbackCommitSha: string | undefined
  ): Promise<void> {
    for (const batch of chunk(documents, DOCUMENT_INSERT_CHUNK)) {
      await client.query(
        `
          INSERT INTO documents (
            id, repository_id, path, commit_sha, title, owner, status,
            last_verified, review_cycle_days, content, updated_at
          )
          VALUES ${valuesClause(batch.length, 10, ["now()"])}
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
        batch.flatMap((document) => [
          document.id,
          document.repositoryId,
          document.path,
          document.commitSha ?? fallbackCommitSha ?? null,
          document.metadata.title,
          document.metadata.owner ?? null,
          document.metadata.status,
          document.metadata.lastVerified ?? null,
          document.metadata.reviewCycleDays ?? null,
          document.content
        ])
      );
    }
  }

  // Inserts sections in batched multi-row INSERTs. Callers are responsible for
  // clearing the affected documents' existing sections first. Shared by the full
  // and incremental save paths; runs on the caller's transaction client.
  private async insertSections(client: pg.PoolClient, sections: DocumentSection[]): Promise<void> {
    for (const batch of chunk(sections, SECTION_INSERT_CHUNK)) {
      await client.query(
        `
          INSERT INTO document_sections (
            id, document_id, path, heading, heading_path, anchor, ordinal, content
          )
          VALUES ${valuesClause(batch.length, 8)}
        `,
        batch.flatMap((section) => [
          section.id,
          section.documentId,
          section.path,
          section.heading,
          section.headingPath,
          section.anchor,
          section.ordinal,
          section.content
        ])
      );
    }
  }

  async loadAll(): Promise<LoadedKnowledge> {
    const [repositoryRows, documentRows, sectionRows] = await Promise.all([
      this.pool.query<RepositoryRow>(
        "SELECT id, name, remote_url, default_branch, local_path, provider, indexed_commit_sha FROM repositories"
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

    const repositories: LoadedRepository[] = repositoryRows.rows.map((row) => ({
      repository: {
        id: row.id,
        name: row.name,
        remoteUrl: row.remote_url ?? undefined,
        defaultBranch: row.default_branch,
        localPath: row.local_path,
        provider: row.provider as RepositoryRef["provider"]
      },
      indexedCommitSha: row.indexed_commit_sha ?? undefined
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

  async searchByKeyword(
    query: string,
    limit: number,
    repositoryIds?: string[]
  ): Promise<Array<{ id: string; relevance: number }>> {
    // Empty/stopword-only queries produce an empty tsquery, which matches nothing.
    if (query.trim().length === 0) {
      return [];
    }
    // A null filter ($3) matches every repository; otherwise restrict to the flow's
    // scope via the section -> document -> repository join. websearch_to_tsquery
    // tolerates free-form user input; the GIN index on search_tsv serves the @@ match.
    const repositoryFilter = repositoryIds && repositoryIds.length > 0 ? repositoryIds : null;
    const result = await this.pool.query<{ id: string; relevance: string }>(
      `
        SELECT s.id, ts_rank(s.search_tsv, websearch_to_tsquery('english', $1)) AS relevance
        FROM document_sections s
        JOIN documents d ON d.id = s.document_id
        WHERE s.search_tsv @@ websearch_to_tsquery('english', $1)
          AND ($3::text[] IS NULL OR d.repository_id = ANY($3))
        ORDER BY relevance DESC
        LIMIT $2
      `,
      [query, limit, repositoryFilter]
    );
    // ts_rank is unbounded; normalise into [0,1] so it composes with vector
    // similarities in the fusion step the same way the in-memory path does.
    return result.rows.map((row) => ({ id: row.id, relevance: normaliseRank(Number(row.relevance)) }));
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

  async saveSectionEmbeddings(entries: SectionEmbeddingToSave[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    // One multi-row UPDATE per chunk instead of one round-trip per section —
    // a provider batch of, say, 64 embeddings previously meant 64 sequential
    // UPDATE statements.
    for (const batch of chunk(entries, EMBEDDING_UPDATE_CHUNK)) {
      await this.pool.query(
        `
          UPDATE document_sections AS s
          SET embedding = v.embedding::vector
          FROM (VALUES ${valuesClause(batch.length, 2)}) AS v(id, embedding)
          WHERE s.id = v.id
        `,
        batch.flatMap((entry) => [entry.id, toVectorLiteral(entry.embedding)])
      );
    }
  }
}

interface RepositoryRow {
  id: string;
  name: string;
  remote_url: string | null;
  default_branch: string;
  local_path: string;
  provider: string;
  indexed_commit_sha: string | null;
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

// ts_rank returns a small non-negative score (typically well under 1 for short
// sections). Map it into [0,1] with a saturating curve so a strong match trends
// toward 1 while staying comparable to cosine similarities during fusion.
function normaliseRank(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) {
    return 0;
  }
  return rank / (rank + 0.1);
}
