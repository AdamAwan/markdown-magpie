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
import { toVectorLiteral } from "./vector-literal.js";

// Bind-parameter budget per statement (Postgres caps at 65535). Documents bind
// 10 params/row and sections 8, so these chunk sizes stay well under the cap.
const DOCUMENT_INSERT_CHUNK = 500;
const SECTION_INSERT_CHUNK = 1000;
// Embedding updates bind 2 params/row (id, embedding); keep chunks well under
// the 65535 bind-parameter cap while still cutting round-trips drastically.
const EMBEDDING_UPDATE_CHUNK = 1000;

// A section's identity at a moment in time: the md5 of (heading, content) plus
// when that pair last changed. Produced only by sectionFingerprints (below) so
// the hash expression can't fork between writers and readers.
export interface SectionFingerprint {
  sectionId: string;
  contentHash: string;
  contentChangedAt: string;
}

export class PostgresKnowledgeStore
  implements KnowledgePersistence, SectionVectorSearch, SectionKeywordSearch, EmbeddingPersistence
{
  // `embeddingModel` identifies the configured embedding model (see
  // embeddingModelId in platform/providers.ts). Vectors from different models
  // are not comparable, so saves stamp it, vector search only matches it, and a
  // stored section whose stamp differs counts as needing (re-)embedding.
  // Undefined (no embeddings configured) preserves the unversioned behaviour.
  constructor(
    private readonly pool: pg.Pool,
    private readonly embeddingModel?: string
  ) {}

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

      // Prune documents (cascading to their sections) for source files that no
      // longer exist in the repository, so a re-index doesn't leave stale docs
      // behind. The incoming set is authoritative for this repository.
      await client.query("DELETE FROM documents WHERE repository_id = $1 AND path <> ALL($2::text[])", [
        summary.repository.id,
        documents.map((document) => document.path)
      ]);

      // Replace the surviving documents' sections via an upsert that carries each
      // unchanged section's embedding forward, so a full re-index no longer wipes
      // (and forces re-computation of) vectors for text that didn't change.
      await this.replaceSections(
        client,
        documents.map((document) => document.id),
        sections
      );

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
  // upserts the document row and replaces its sections via replaceSections (which
  // carries unchanged sections' embeddings forward) — then advances the
  // repository's indexed_commit_sha. Unchanged rows are never touched (unlike
  // saveIndexedRepository's whole-repository rewrite).
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

        // Replace each upserted document's sections, carrying unchanged sections'
        // embeddings forward. A 1-line edit in a many-section doc now only resets
        // (and re-embeds) the sections that actually changed, not the whole doc.
        await this.replaceSections(
          client,
          input.upsertedDocuments.map((document) => document.id),
          input.upsertedSections
        );
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

  // Replaces the sections of the given documents with `sections`, preserving the
  // embeddings of sections whose content and heading are unchanged. Section ids are
  // deterministic (`${documentId}:${ordinal}`), so an unchanged section keeps its
  // id across re-indexes and its already-computed vector is carried forward rather
  // than wiped and re-embedded. Sections no longer present in the incoming set
  // (removed, or ids shifted by an upstream heading change) are deleted so nothing
  // stale survives. Runs on the caller's transaction client. `documentIds` is the
  // authoritative set of documents whose sections this call owns — a document that
  // now has zero sections still has its stale rows pruned.
  private async replaceSections(
    client: pg.PoolClient,
    documentIds: string[],
    sections: DocumentSection[]
  ): Promise<void> {
    if (documentIds.length === 0) {
      return;
    }

    await this.upsertSections(client, sections);

    // Delete rows for these documents that are absent from the new id set. An
    // anti-join against unnest($2) is a hash anti-join in Postgres, unlike
    // `id <> ALL($2)` which rescans the whole array for every candidate row.
    await client.query(
      `
        DELETE FROM document_sections s
        WHERE s.document_id = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS keep(id) WHERE keep.id = s.id
          )
      `,
      [documentIds, sections.map((section) => section.id)]
    );
  }

  // Upserts sections in batched multi-row INSERTs keyed on the section id. On
  // conflict the row's columns are refreshed, but the embedding is kept only when
  // both content and heading are byte-identical to the stored row — otherwise it
  // resets to NULL so the background embedder (which targets embedding IS NULL)
  // recomputes exactly the changed sections. The embedding_model stamp travels
  // with the vector: carried forward when the vector is, cleared when it resets.
  // Shared by the full and incremental save paths; runs on the caller's
  // transaction client.
  private async upsertSections(client: pg.PoolClient, sections: DocumentSection[]): Promise<void> {
    for (const batch of chunk(sections, SECTION_INSERT_CHUNK)) {
      await client.query(
        `
          INSERT INTO document_sections (
            id, document_id, path, heading, heading_path, anchor, ordinal, content
          )
          VALUES ${valuesClause(batch.length, 8)}
          ON CONFLICT (id) DO UPDATE
          SET document_id = EXCLUDED.document_id,
              path = EXCLUDED.path,
              heading = EXCLUDED.heading,
              heading_path = EXCLUDED.heading_path,
              anchor = EXCLUDED.anchor,
              ordinal = EXCLUDED.ordinal,
              content = EXCLUDED.content,
              embedding = CASE
                WHEN document_sections.content = EXCLUDED.content
                  AND document_sections.heading = EXCLUDED.heading
                THEN document_sections.embedding
                ELSE NULL
              END,
              embedding_model = CASE
                WHEN document_sections.content = EXCLUDED.content
                  AND document_sections.heading = EXCLUDED.heading
                THEN document_sections.embedding_model
                ELSE NULL
              END,
              content_changed_at = CASE
                WHEN document_sections.content = EXCLUDED.content
                  AND document_sections.heading = EXCLUDED.heading
                THEN document_sections.content_changed_at
                ELSE now()
              END
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

  // Point-in-time identity of sections, for questionnaire answer-reuse checks:
  // the hash expression is the single source of truth for "byte-identical" —
  // snapshot (at item approval) and check (at reuse time) both call this method,
  // so the two sides can never drift. Ids with no row are simply absent; callers
  // treat absence as "changed" (the safe direction).
  async sectionFingerprints(sectionIds: string[]): Promise<SectionFingerprint[]> {
    if (sectionIds.length === 0) {
      return [];
    }
    const result = await this.pool.query<{ id: string; hash: string; changed_at: Date }>(
      `
        SELECT id, md5(heading || E'\\x1f' || content) AS hash, content_changed_at AS changed_at
        FROM document_sections
        WHERE id = ANY($1::text[])
      `,
      [sectionIds]
    );
    return result.rows.map((row) => ({
      sectionId: row.id,
      contentHash: row.hash,
      contentChangedAt: row.changed_at.toISOString()
    }));
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
    // destination via the section -> document -> repository join. A null model
    // ($4, unversioned store) matches every vector; otherwise only vectors the
    // configured model produced are comparable to the query embedding — stale
    // vectors from a previous model are invisible here until re-embedded.
    const repositoryFilter = repositoryIds && repositoryIds.length > 0 ? repositoryIds : null;
    const result = await this.pool.query<{ id: string; similarity: string }>(
      `
        SELECT s.id, 1 - (s.embedding <=> $1::vector) AS similarity
        FROM document_sections s
        JOIN documents d ON d.id = s.document_id
        WHERE s.embedding IS NOT NULL
          AND ($3::text[] IS NULL OR d.repository_id = ANY($3))
          AND ($4::text IS NULL OR s.embedding_model = $4)
        ORDER BY s.embedding <=> $1::vector
        LIMIT $2
      `,
      [literal, limit, repositoryFilter, this.embeddingModel ?? null]
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

  // A section "needs embedding" when it has no vector, or (on a versioned store)
  // when its vector was produced by a different model than the configured one —
  // a model change re-embeds exactly like a content change, via the same
  // background-embedder path. On an unversioned store ($3 NULL) only vectorless
  // sections qualify, preserving the original behaviour.
  async listSectionsNeedingEmbedding(limit: number, repositoryId?: string): Promise<SectionToEmbed[]> {
    const result = await this.pool.query<{ id: string; heading: string; content: string }>(
      `
        SELECT s.id, s.heading, s.content
        FROM document_sections s
        JOIN documents d ON d.id = s.document_id
        WHERE (s.embedding IS NULL OR ($3::text IS NOT NULL AND s.embedding_model IS DISTINCT FROM $3))
          AND ($1::text IS NULL OR d.repository_id = $1)
        ORDER BY s.id
        LIMIT $2
      `,
      [repositoryId ?? null, limit, this.embeddingModel ?? null]
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
        WHERE (s.embedding IS NULL OR ($2::text IS NOT NULL AND s.embedding_model IS DISTINCT FROM $2))
          AND ($1::text IS NULL OR d.repository_id = $1)
      `,
      [repositoryId ?? null, this.embeddingModel ?? null]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  // One-time upgrade grace for vectors that predate embedding-model versioning:
  // a NULL-stamped vector can only have been produced by the model that was
  // configured when it was computed, so an unchanged configuration adopts them
  // under the current model instead of paying a full-corpus re-embed. If the
  // operator switched models at the same time, the stamp is wrong in exactly the
  // way it already was pre-versioning — and the next genuine model change fixes
  // it. New saves always stamp, so this converges to a no-op.
  async adoptUnversionedEmbeddings(): Promise<number> {
    if (!this.embeddingModel) {
      return 0;
    }
    const result = await this.pool.query(
      "UPDATE document_sections SET embedding_model = $1 WHERE embedding IS NOT NULL AND embedding_model IS NULL",
      [this.embeddingModel]
    );
    return result.rowCount ?? 0;
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
    await this.pool.query("UPDATE document_sections SET embedding = $2::vector, embedding_model = $3 WHERE id = $1", [
      id,
      toVectorLiteral(embedding),
      this.embeddingModel ?? null
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
          SET embedding = v.embedding::vector, embedding_model = $${batch.length * 2 + 1}
          FROM (VALUES ${valuesClause(batch.length, 2)}) AS v(id, embedding)
          WHERE s.id = v.id
        `,
        [...batch.flatMap((entry) => [entry.id, toVectorLiteral(entry.embedding)]), this.embeddingModel ?? null]
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

// ts_rank returns a small non-negative score (typically well under 1 for short
// sections). Map it into [0,1] with a saturating curve so a strong match trends
// toward 1 while staying comparable to cosine similarities during fusion.
function normaliseRank(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) {
    return 0;
  }
  return rank / (rank + 0.1);
}
