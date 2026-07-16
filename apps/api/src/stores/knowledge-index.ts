import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DocumentSection,
  EmbeddingProvider,
  GitRepositoryContext,
  KnowledgeDocument,
  RankedSection,
  RepositoryRef
} from "@magpie/core";
import { parseMarkdownDocument, splitIntoSections } from "@magpie/markdown";
import { isAncestor, listChangedMarkdown, resolvePrimaryBranch, type ChangedMarkdownFile } from "@magpie/git";
import { fuseRankings } from "@magpie/retrieval";
import { logger } from "../logger.js";
import { LruCache } from "./lru-cache.js";

const execFileAsync = promisify(execFile);

export interface IndexedRepositorySummary {
  repository: RepositoryRef;
  documentCount: number;
  sectionCount: number;
  commitSha?: string;
}

// A loaded repository carries the SHA it was last fully/incrementally indexed at
// (undefined when never indexed under SHA tracking), so the in-memory index knows
// the prior commit after a restart and can attempt an incremental reindex.
export interface LoadedRepository {
  repository: RepositoryRef;
  indexedCommitSha?: string;
}

export interface LoadedKnowledge {
  repositories: LoadedRepository[];
  documents: KnowledgeDocument[];
  sections: DocumentSection[];
}

// One incremental reindex to persist: documents to upsert (with their freshly
// split sections) and document ids to delete outright (file removed or renamed
// away). `commitSha` becomes the repository's new indexed_commit_sha.
export interface IncrementalIndexInput {
  repository: RepositoryRef;
  commitSha?: string;
  upsertedDocuments: KnowledgeDocument[];
  upsertedSections: DocumentSection[];
  deletedDocumentIds: string[];
}

export interface KnowledgePersistence {
  saveIndexedRepository(
    summary: IndexedRepositorySummary,
    documents: KnowledgeDocument[],
    sections: DocumentSection[]
  ): Promise<void>;
  // Persists only the documents/sections touched by an incremental reindex (plus
  // the repository's new indexed SHA) in a single transaction, leaving unchanged
  // rows untouched. Falls outside the full-index save path's whole-repo rewrite.
  applyIncrementalIndex(input: IncrementalIndexInput): Promise<void>;
  loadAll(): Promise<LoadedKnowledge>;
  reset(): Promise<void>;
}

export interface SectionVectorSearch {
  searchByEmbedding(
    embedding: number[],
    limit: number,
    repositoryIds?: string[]
  ): Promise<Array<{ id: string; similarity: number }>>;
}

export interface SectionKeywordSearch {
  // Runs keyword search in the persistence backend (Postgres full-text search)
  // rather than scanning every section in memory, returning ranked section ids
  // with a [0,1] relevance. Repository scoping is applied inside the query.
  searchByKeyword(
    query: string,
    limit: number,
    repositoryIds?: string[]
  ): Promise<Array<{ id: string; relevance: number }>>;
}

export interface SectionToEmbed {
  id: string;
  text: string;
}

export interface SectionEmbeddingToSave {
  id: string;
  embedding: number[];
}

export interface EmbeddingPersistence {
  listSectionsNeedingEmbedding(limit: number, repositoryId?: string): Promise<SectionToEmbed[]>;
  countSectionsNeedingEmbedding(repositoryId?: string): Promise<number>;
  saveSectionEmbedding(id: string, embedding: number[]): Promise<void>;
  // Saves every embedding from one provider batch in a single multi-row
  // statement instead of one round-trip per section.
  saveSectionEmbeddings(entries: SectionEmbeddingToSave[]): Promise<void>;
}

export interface MarkdownUpload {
  path: string;
  content: string;
}

// Heading term match scores 3, body match 1 (see scoreSection); ~6 is the score of a
// strong two-term-in-heading hit, used to normalise keyword scores into [0,1].
const KEYWORD_RELEVANCE_SCALE = 6;
// Over-fetch vector candidates before fusion so good hits are not cut off by a small limit.
const VECTOR_CANDIDATES = 20;
// How many markdown files indexLocalRepository reads+parses concurrently. High
// enough to hide per-file I/O latency, low enough to avoid exhausting file
// descriptors / starving the event loop on repos with very many files.
const READ_CONCURRENCY = 12;
// Markdown files larger than this are skipped (with a warning) rather than
// indexed, so one absurdly large file can't blow up memory or dominate
// indexing time for the rest of the repository.
const MAX_MARKDOWN_FILE_BYTES = 5 * 1024 * 1024;
// Match the vector side's over-fetch when sourcing keyword candidates for fusion.
const KEYWORD_CANDIDATES = 20;
// How many distinct query embeddings to memoize per index instance. A gap
// question's lifecycle re-asks byte-identical text many times (retrieval, gap
// clustering, closure verification), and both embedding providers are raw HTTP
// with no caching — so an unbounded stream of repeat questions would otherwise
// re-embed the same text on every call. A few hundred entries covers the working
// set of live questions cheaply (each vector is 1536 floats ≈ 12 KB).
const QUERY_EMBEDDING_CACHE_SIZE = 500;

export interface HybridSearchOptions {
  embeddingProvider?: EmbeddingProvider;
  vectorSearch?: SectionVectorSearch;
  // When present (Postgres backend), keyword ranking runs in the database instead
  // of the in-memory full-scan path. The in-memory path remains the fallback.
  keywordSearch?: SectionKeywordSearch;
  onNotice?: (message: string) => void;
}

export class InMemoryKnowledgeIndex {
  private readonly documents = new Map<string, KnowledgeDocument>();
  private readonly sections = new Map<string, DocumentSection>();
  private readonly repositories = new Map<string, RepositoryRef>();
  // The commit each repository was last indexed at, tracked separately from
  // RepositoryRef (a shared core type) so incremental reindexing has the prior
  // SHA in memory after a restart. Undefined ⇒ no prior SHA ⇒ full reindex.
  private readonly indexedShaByRepository = new Map<string, string>();
  // Memoizes query-text → embedding so the same question isn't re-embedded on
  // every retrieval. Scoped to this instance, whose embedding provider is fixed,
  // so the normalized query text alone is a sufficient cache key. Cleared with
  // the index on reset(). Query embeddings depend only on the question, not the
  // corpus, so re-indexing never has to invalidate this.
  private readonly queryEmbeddingCache = new LruCache<string, number[]>(QUERY_EMBEDDING_CACHE_SIZE);

  constructor(
    private readonly persistence?: KnowledgePersistence,
    private readonly hybrid: HybridSearchOptions = {}
  ) {}

  /**
   * Loads previously persisted repositories, documents, and sections into the in-memory
   * index. Without this, a Postgres-backed deployment would serve an empty index after a
   * restart until something was re-indexed. Git context is re-derived from each repository's
   * local path so publishing keeps working with fresh branch/SHA state.
   */
  async hydrate(): Promise<void> {
    if (!this.persistence) {
      return;
    }

    const { repositories, documents, sections } = await this.persistence.loadAll();

    for (const { repository, indexedCommitSha } of repositories) {
      const git = await detectGitContext(repository.localPath);
      this.repositories.set(repository.id, {
        ...repository,
        remoteUrl: repository.remoteUrl ?? git.remoteUrl,
        git
      });
      if (indexedCommitSha) {
        this.indexedShaByRepository.set(repository.id, indexedCommitSha);
      }
    }
    for (const document of documents) {
      this.documents.set(document.id, document);
    }
    for (const section of sections) {
      this.sections.set(section.id, section);
    }
  }

  async indexLocalRepository(input: {
    localPath: string;
    repositoryId?: string;
    name?: string;
    configuredBranch?: string;
  }): Promise<IndexedRepositorySummary> {
    const localPath = resolveLocalPath(input.localPath);
    const git = await detectGitContext(localPath);
    const repository: RepositoryRef = {
      id: input.repositoryId ?? slugify(path.basename(localPath)),
      name: input.name ?? path.basename(localPath),
      // The single primary-branch precedence: configured `branch` wins, else the
      // detected origin/HEAD default, else the current branch, else "main". Making
      // this authoritative here means every downstream consumer can read
      // `defaultBranch` instead of re-deriving it and diverging.
      defaultBranch: resolvePrimaryBranch({
        configuredBranch: input.configuredBranch,
        detectedDefault: git.defaultBranch,
        detectedCurrent: git.currentBranch
      }),
      localPath,
      provider: "local",
      remoteUrl: git.remoteUrl,
      git
    };
    const headSha = git.headSha;
    const priorSha = this.indexedShaByRepository.get(repository.id);

    // Decide whether an incremental reindex is provably safe. When any condition
    // is unmet we fall back to a full reindex — correctness never depends on the
    // optimization. See chooseIncremental for the exact fallback conditions.
    const plan = await this.chooseIncremental(repository, git, priorSha, headSha);
    if (plan.kind === "noop") {
      // Source is clean and HEAD is unchanged from the last index, and the repo
      // is already populated: nothing to re-read. Refresh the repository ref so
      // freshly-detected git context (branch/remote) is still kept current.
      this.repositories.set(repository.id, repository);
      return this.summarizeRepository(repository, headSha);
    }
    if (plan.kind === "incremental") {
      return this.incrementalIndex(repository, localPath, headSha, plan.changes);
    }

    return this.fullIndex(repository, localPath, headSha);
  }

  // Re-reads and re-parses every markdown file in the source (the original,
  // always-correct behavior) and replaces the repository's documents/sections.
  private async fullIndex(
    repository: RepositoryRef,
    localPath: string,
    headSha: string | undefined
  ): Promise<IndexedRepositorySummary> {
    const markdownPaths = await findMarkdownFiles(localPath);
    // Read+parse with a bounded worker pool instead of one file at a time: local
    // repos can have thousands of markdown files, and serial I/O made indexing
    // time scale linearly with file count. `markdownPaths` is sorted, and results
    // are written into a pre-sized array by original index, so output ordering
    // stays deterministic regardless of which read finishes first.
    const loaded: Array<{ document: KnowledgeDocument; sections: DocumentSection[] } | undefined> = new Array(
      markdownPaths.length
    );

    for (let start = 0; start < markdownPaths.length; start += READ_CONCURRENCY) {
      const chunk = markdownPaths.slice(start, start + READ_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((markdownPath) => this.readDocument(repository, localPath, markdownPath, headSha))
      );

      for (const [offset, result] of results.entries()) {
        loaded[start + offset] = result;
      }
    }

    const documents: KnowledgeDocument[] = [];
    const sections: DocumentSection[] = [];
    for (const entry of loaded) {
      if (!entry) {
        continue;
      }
      documents.push(entry.document);
      sections.push(...entry.sections);
    }

    this.repositories.set(repository.id, repository);
    this.pruneRepository(repository.id, new Set(documents.map((document) => document.id)));
    for (const document of documents) {
      this.documents.set(document.id, document);
    }
    for (const section of sections) {
      this.sections.set(section.id, section);
    }
    this.setIndexedSha(repository.id, headSha);

    const summary: IndexedRepositorySummary = {
      repository,
      documentCount: documents.length,
      sectionCount: sections.length,
      commitSha: headSha
    };

    await this.persistence?.saveIndexedRepository(summary, documents, sections);
    return summary;
  }

  // Applies only the files that changed between the prior indexed SHA and HEAD.
  // Unchanged documents are left exactly as they are (their stored commitSha
  // stays at whatever commit last changed them); only re-read documents get the
  // new head SHA. Persists the delta via applyIncrementalIndex.
  private async incrementalIndex(
    repository: RepositoryRef,
    localPath: string,
    headSha: string | undefined,
    changes: ChangedMarkdownFile[]
  ): Promise<IndexedRepositorySummary> {
    const subdirPrefix = subdirectoryPrefix(repository.git);

    // Resolve the diff (work-tree-relative) paths to this index's document-id
    // path space, which is relative to the indexed subtree. Changes outside the
    // indexed subtree are ignored. Renames are handled as delete(old)+add(new).
    const toReadRelativePaths = new Set<string>();
    const deletedDocumentIds = new Set<string>();

    for (const change of changes) {
      const newRelative = stripSubdir(change.path, subdirPrefix);
      const oldRelative = change.oldPath ? stripSubdir(change.oldPath, subdirPrefix) : undefined;

      if (change.status === "deleted") {
        if (newRelative !== undefined) {
          deletedDocumentIds.add(`${repository.id}:${newRelative}`);
        }
        continue;
      }

      // added / modified / copied / renamed-target: re-read the new path.
      if (newRelative !== undefined) {
        toReadRelativePaths.add(newRelative);
      }
      // A rename's source path leaves the indexed subtree (or moves within it):
      // drop the old document. If the rename source is the same as the new path
      // it is a no-op; otherwise remove the old id.
      if (change.status === "renamed" && oldRelative !== undefined && oldRelative !== newRelative) {
        deletedDocumentIds.add(`${repository.id}:${oldRelative}`);
      }
    }

    // A path can appear as both deleted-then-re-added across entries; an upsert
    // wins over a delete for the same id.
    const upsertedDocuments: KnowledgeDocument[] = [];
    const upsertedSections: DocumentSection[] = [];
    const relativePaths = [...toReadRelativePaths];
    for (let start = 0; start < relativePaths.length; start += READ_CONCURRENCY) {
      const chunk = relativePaths.slice(start, start + READ_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((relativePath) =>
          this.readDocument(repository, localPath, path.join(localPath, ...relativePath.split("/")), headSha)
        )
      );
      for (const result of results) {
        if (!result) {
          continue;
        }
        upsertedDocuments.push(result.document);
        upsertedSections.push(...result.sections);
        deletedDocumentIds.delete(result.document.id);
      }
    }

    // Apply to the in-memory maps without reloading the world. The set of
    // documents whose sections must be dropped is the deleted ones plus the
    // re-read (upserted) ones; build a documentId -> sectionIds index in a single
    // pass over the section map so removal is O(changed) rather than scanning the
    // whole section map once per affected document (which was O(changed × total)).
    const affectedDocumentIds = new Set<string>(deletedDocumentIds);
    for (const document of upsertedDocuments) {
      affectedDocumentIds.add(document.id);
    }
    const sectionIdsByDocumentId = this.indexSectionIdsByDocument(affectedDocumentIds);

    this.repositories.set(repository.id, repository);
    for (const documentId of affectedDocumentIds) {
      for (const sectionId of sectionIdsByDocumentId.get(documentId) ?? []) {
        this.sections.delete(sectionId);
      }
    }
    for (const documentId of deletedDocumentIds) {
      this.documents.delete(documentId);
    }
    for (const document of upsertedDocuments) {
      this.documents.set(document.id, document);
    }
    for (const section of upsertedSections) {
      this.sections.set(section.id, section);
    }
    this.setIndexedSha(repository.id, headSha);

    await this.persistence?.applyIncrementalIndex({
      repository,
      commitSha: headSha,
      upsertedDocuments,
      upsertedSections,
      deletedDocumentIds: [...deletedDocumentIds]
    });

    return this.summarizeRepository(repository, headSha);
  }

  // Reads, size-guards, and parses one markdown file into a document + sections.
  // Returns undefined when the file is missing (e.g. a diff entry already gone)
  // or exceeds the size guard, so callers skip it.
  private async readDocument(
    repository: RepositoryRef,
    localPath: string,
    markdownPath: string,
    commitSha: string | undefined
  ): Promise<{ document: KnowledgeDocument; sections: DocumentSection[] } | undefined> {
    let fileStat;
    try {
      fileStat = await stat(markdownPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    if (fileStat.size > MAX_MARKDOWN_FILE_BYTES) {
      logger.warn(
        { path: markdownPath, bytes: fileStat.size, limitBytes: MAX_MARKDOWN_FILE_BYTES },
        "skipping markdown file: exceeds max indexing size"
      );
      return undefined;
    }

    const content = await readFile(markdownPath, "utf8");
    const relativePath = toPosixPath(path.relative(localPath, markdownPath));
    const parsed = parseMarkdownDocument(content);
    const document: KnowledgeDocument = {
      id: `${repository.id}:${relativePath}`,
      repositoryId: repository.id,
      path: relativePath,
      commitSha,
      metadata: parsed.metadata,
      content
    };
    return { document, sections: splitIntoSections(document) };
  }

  // Decides the reindex strategy. Returns "full" whenever incremental cannot be
  // proven safe, "noop" when HEAD is unchanged and the repo is already populated,
  // and "incremental" with the markdown diff otherwise.
  private async chooseIncremental(
    repository: RepositoryRef,
    git: GitRepositoryContext,
    priorSha: string | undefined,
    headSha: string | undefined
  ): Promise<{ kind: "full" } | { kind: "noop" } | { kind: "incremental"; changes: ChangedMarkdownFile[] }> {
    // Not a git work tree, or no resolvable HEAD: nothing to diff against.
    if (git.scope === "not-git" || !headSha) {
      return { kind: "full" };
    }
    // Working tree has uncommitted edits: a name-status diff between commits would
    // miss them, so re-read everything.
    if (git.hasUncommittedChanges) {
      return { kind: "full" };
    }
    // No prior indexed SHA (first index, or pre-feature data): full.
    if (!priorSha) {
      return { kind: "full" };
    }
    if (priorSha === headSha) {
      // Already at the indexed commit and clean — skip if populated, else (e.g.
      // a fresh process that hydrated metadata but no docs) do a full index.
      return this.repositoryIsPopulated(repository.id) ? { kind: "noop" } : { kind: "full" };
    }
    // History rewritten (force-push/rebase) so the prior commit is unreachable:
    // a prior..head diff would be meaningless. Re-read everything.
    if (!(await isAncestor(repository.localPath, priorSha, headSha))) {
      return { kind: "full" };
    }

    // Diff from the work-tree root so the subdirectory pathspec is interpreted
    // relative to the root (git pathspecs are cwd-relative), and the returned
    // paths are root-relative — matching stripSubdir's expectation.
    const diffCwd = repository.git?.workTreeRoot ?? repository.localPath;
    const changes = await listChangedMarkdown(diffCwd, priorSha, headSha, {
      pathspec: subdirectoryPrefix(repository.git)
    });
    return { kind: "incremental", changes };
  }

  private repositoryIsPopulated(repositoryId: string): boolean {
    for (const document of this.documents.values()) {
      if (document.repositoryId === repositoryId) {
        return true;
      }
    }
    return false;
  }

  private setIndexedSha(repositoryId: string, sha: string | undefined): void {
    if (sha) {
      this.indexedShaByRepository.set(repositoryId, sha);
    } else {
      this.indexedShaByRepository.delete(repositoryId);
    }
  }

  private summarizeRepository(repository: RepositoryRef, commitSha: string | undefined): IndexedRepositorySummary {
    let documentCount = 0;
    let sectionCount = 0;
    for (const document of this.documents.values()) {
      if (document.repositoryId === repository.id) {
        documentCount += 1;
      }
    }
    for (const section of this.sections.values()) {
      const ownerRepository = this.documents.get(section.documentId)?.repositoryId;
      if (ownerRepository === repository.id) {
        sectionCount += 1;
      }
    }
    return { repository, documentCount, sectionCount, commitSha };
  }

  // Builds a documentId -> sectionIds index for the given documents in one pass
  // over the section map, so callers can delete a batch of documents' sections by
  // lookup instead of re-scanning the whole map per document. Only the requested
  // documents are kept, keeping the returned map small.
  private indexSectionIdsByDocument(documentIds: Set<string>): Map<string, string[]> {
    const byDocument = new Map<string, string[]>();
    if (documentIds.size === 0) {
      return byDocument;
    }
    for (const [sectionId, section] of this.sections) {
      if (!documentIds.has(section.documentId)) {
        continue;
      }
      const existing = byDocument.get(section.documentId);
      if (existing) {
        existing.push(sectionId);
      } else {
        byDocument.set(section.documentId, [sectionId]);
      }
    }
    return byDocument;
  }

  async indexMarkdownDocuments(input: {
    documents: MarkdownUpload[];
    repositoryId?: string;
    name?: string;
  }): Promise<IndexedRepositorySummary> {
    const repositoryId = input.repositoryId ?? "uploaded";
    const repository: RepositoryRef = {
      id: repositoryId,
      name: input.name ?? "Uploaded Markdown",
      defaultBranch: "main",
      localPath: "uploaded",
      provider: "local"
    };
    const documents: KnowledgeDocument[] = [];
    const sections: DocumentSection[] = [];

    for (const upload of input.documents) {
      const parsed = parseMarkdownDocument(upload.content);
      const document: KnowledgeDocument = {
        id: `${repository.id}:${upload.path}`,
        repositoryId: repository.id,
        path: upload.path,
        metadata: parsed.metadata,
        content: upload.content
      };

      documents.push(document);
      sections.push(...splitIntoSections(document));
    }

    this.repositories.set(repository.id, repository);
    // Prune docs/sections for files no longer in the set; surviving documents'
    // sections are overwritten by id below (pruneRepository already dropped
    // anything stale for documents that didn't survive).
    this.pruneRepository(repository.id, new Set(documents.map((document) => document.id)));
    for (const document of documents) {
      this.documents.set(document.id, document);
    }
    for (const section of sections) {
      this.sections.set(section.id, section);
    }

    const summary: IndexedRepositorySummary = {
      repository,
      documentCount: documents.length,
      sectionCount: sections.length
    };

    await this.persistence?.saveIndexedRepository(summary, documents, sections);
    return summary;
  }

  async search(question: string, limit: number, repositoryIds?: string[]): Promise<RankedSection[]> {
    const keywordRanked = await this.keywordRank(question, Math.max(limit, KEYWORD_CANDIDATES), repositoryIds);

    const { embeddingProvider, vectorSearch, onNotice } = this.hybrid;
    if (!embeddingProvider || !vectorSearch) {
      return keywordRanked.slice(0, limit);
    }

    let vectorHits: Array<{ id: string; similarity: number }>;
    try {
      const queryVector = await this.embedQuery(question, embeddingProvider);
      vectorHits = await vectorSearch.searchByEmbedding(queryVector, Math.max(limit, VECTOR_CANDIDATES), repositoryIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      onNotice?.(`Vector search unavailable, falling back to keyword search: ${message}`);
      return keywordRanked.slice(0, limit);
    }

    const keywordIds = keywordRanked.map((result) => result.section.id);
    const vectorIds = vectorHits.map((hit) => hit.id);
    const fused = fuseRankings([vectorIds, keywordIds]);

    const similarityById = new Map(vectorHits.map((hit) => [hit.id, hit.similarity]));
    const keywordRelevanceById = new Map(keywordRanked.map((result) => [result.section.id, result.relevance]));
    const repositoryFilter = this.repositoryFilterSet(repositoryIds);

    return (
      [...new Set([...vectorIds, ...keywordIds])]
        .map((id) => ({
          id,
          fused: fused.get(id) ?? 0,
          relevance: Math.max(similarityById.get(id) ?? 0, keywordRelevanceById.get(id) ?? 0)
        }))
        .sort((left, right) => right.fused - left.fused)
        .map(({ id, relevance }) => {
          const section = this.sections.get(id);
          return section ? { section, relevance } : undefined;
        })
        .filter((result): result is RankedSection => result !== undefined)
        // Re-apply the repository filter post-fusion so a vector backend that ignores
        // the scope (e.g. a test stub) still cannot leak sections from other flows.
        .filter((result) => this.sectionInRepositories(result.section, repositoryFilter))
        .slice(0, limit)
    );
  }

  // Embeds a query, memoizing the result so byte-identical questions (after
  // whitespace normalization) don't hit the provider more than once. The provider
  // still receives the original question text; only the cache key is normalized.
  // A miss populates the cache; a provider failure is not cached (it propagates so
  // search() can fall back to keyword-only retrieval).
  private async embedQuery(question: string, provider: EmbeddingProvider): Promise<number[]> {
    const key = normalizeQueryText(question);
    const cached = this.queryEmbeddingCache.get(key);
    if (cached) {
      return cached;
    }
    const [vector] = await provider.embed([question]);
    if (!vector) {
      throw new Error("Embedding provider returned no vector for the query");
    }
    this.queryEmbeddingCache.set(key, vector);
    return vector;
  }

  private async keywordRank(question: string, limit: number, repositoryIds?: string[]): Promise<RankedSection[]> {
    const keywordSearch = this.hybrid.keywordSearch;
    if (keywordSearch) {
      try {
        const hits = await keywordSearch.searchByKeyword(question, limit, repositoryIds);
        return hits
          .map((hit) => {
            const section = this.sections.get(hit.id);
            return section ? { section, relevance: hit.relevance } : undefined;
          })
          .filter((result): result is RankedSection => result !== undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        this.hybrid.onNotice?.(`Postgres keyword search unavailable, falling back to in-memory scan: ${message}`);
      }
    }

    return this.keywordRankInMemory(question, limit, repositoryIds);
  }

  // In-memory keyword ranking used when no Postgres backend is configured (tests,
  // no-persistence mode) or when the Postgres path errors. Scans candidate sections,
  // scoring them by term overlap, and selects the top-K without a full sort.
  private keywordRankInMemory(question: string, limit: number, repositoryIds?: string[]): RankedSection[] {
    const terms = tokenize(question);
    if (terms.length === 0) {
      return [];
    }

    const repositoryFilter = this.repositoryFilterSet(repositoryIds);
    const scored: Array<{ section: DocumentSection; score: number }> = [];
    for (const section of this.sections.values()) {
      if (!this.sectionInRepositories(section, repositoryFilter)) {
        continue;
      }
      const score = scoreSection(section, terms);
      if (score > 0) {
        scored.push({ section, score });
      }
    }

    return selectTopK(scored, limit, (left, right) => right.score - left.score).map((result) => ({
      section: result.section,
      relevance: Math.min(1, result.score / KEYWORD_RELEVANCE_SCALE)
    }));
  }

  // Normalises the optional repository filter to a Set for O(1) membership tests
  // (the per-section filter ran an Array.includes scan on every section before).
  private repositoryFilterSet(repositoryIds?: string[]): Set<string> | undefined {
    return repositoryIds && repositoryIds.length > 0 ? new Set(repositoryIds) : undefined;
  }

  // Resolves a section to its owning repository via the document map and tests it
  // against an optional repository filter. An undefined filter matches every
  // section (unscoped search); a section whose document is missing is excluded.
  private sectionInRepositories(section: DocumentSection, repositoryIds?: string[] | Set<string>): boolean {
    const filter = repositoryIds instanceof Set ? repositoryIds : this.repositoryFilterSet(repositoryIds);
    if (!filter) {
      return true;
    }

    const repositoryId = this.documents.get(section.documentId)?.repositoryId;
    return repositoryId !== undefined && filter.has(repositoryId);
  }

  // `options` is optional so the many internal callers that need the full
  // unbounded list (publication diffing, dedupe/split scheduling, etc.) are
  // unaffected; only the HTTP route passes limit/offset to paginate.
  listDocuments(options?: { limit?: number; offset?: number }): KnowledgeDocument[] {
    const sorted = [...this.documents.values()].sort((left, right) => left.path.localeCompare(right.path));
    return paginate(sorted, options);
  }

  countDocuments(): number {
    return this.documents.size;
  }

  // Resolves one section by id — the lookup behind GET /knowledge/sections/:id,
  // which lets MCP clients expand a citation's excerpt into the full evidence.
  getSection(id: string): DocumentSection | undefined {
    return this.sections.get(id);
  }

  listRepositories(options?: { limit?: number; offset?: number }): RepositoryRef[] {
    const sorted = [...this.repositories.values()].sort((left, right) => left.name.localeCompare(right.name));
    return paginate(sorted, options);
  }

  countRepositories(): number {
    return this.repositories.size;
  }

  getStats(): { repositoryCount: number; documentCount: number; sectionCount: number } {
    return {
      repositoryCount: this.repositories.size,
      documentCount: this.documents.size,
      sectionCount: this.sections.size
    };
  }

  // Drops previously-indexed documents (and their sections) for a repository
  // that are absent from the freshly-indexed set, so re-indexing a source whose
  // files were deleted doesn't leave stale docs/sections behind. Sections are
  // grouped by documentId once up front (O(S)) rather than re-scanning the full
  // section map per stale document (O(D×S)).
  private pruneRepository(repositoryId: string, keepDocumentIds: Set<string>): void {
    const staleDocumentIds: string[] = [];
    for (const [documentId, document] of this.documents) {
      if (document.repositoryId === repositoryId && !keepDocumentIds.has(documentId)) {
        staleDocumentIds.push(documentId);
      }
    }
    if (staleDocumentIds.length === 0) {
      return;
    }

    const sectionIdsByDocumentId = new Map<string, string[]>();
    for (const [sectionId, section] of this.sections) {
      const existing = sectionIdsByDocumentId.get(section.documentId);
      if (existing) {
        existing.push(sectionId);
      } else {
        sectionIdsByDocumentId.set(section.documentId, [sectionId]);
      }
    }

    for (const documentId of staleDocumentIds) {
      this.documents.delete(documentId);
      for (const sectionId of sectionIdsByDocumentId.get(documentId) ?? []) {
        this.sections.delete(sectionId);
      }
    }
  }

  reset(): void {
    this.documents.clear();
    this.sections.clear();
    this.repositories.clear();
    this.indexedShaByRepository.clear();
    this.queryEmbeddingCache.clear();
  }
}

// Cache key for a query embedding. The embedding is a function of the exact text
// sent to the provider, so we only collapse insignificant whitespace differences
// (leading/trailing and internal runs) — not case, which the provider treats as
// meaningful. Two questions that differ only by such whitespace re-use one vector.
function normalizeQueryText(question: string): string {
  return question.trim().replace(/\s+/g, " ");
}

// The indexed subtree's path relative to the git work-tree root, normalised to a
// posix prefix (or undefined for a repository-root index). Diff paths from git
// are work-tree-relative, so this is what we strip to reach the document-id path
// space (which is relative to the indexed subtree).
function subdirectoryPrefix(git: GitRepositoryContext | undefined): string | undefined {
  const relative = git?.relativePathFromRoot;
  if (!relative || relative === ".") {
    return undefined;
  }
  return relative.replace(/^\/+|\/+$/g, "") || undefined;
}

// Maps a work-tree-relative diff path into the indexed subtree's path space by
// stripping the subdirectory prefix. Returns undefined when the path lies
// outside the indexed subtree (so the change is ignored).
function stripSubdir(workTreeRelativePath: string, subdirPrefix: string | undefined): string | undefined {
  const normalized = toPosixPath(workTreeRelativePath).replace(/^\/+/, "");
  if (!subdirPrefix) {
    return normalized;
  }
  if (normalized === subdirPrefix) {
    // The subtree path itself can't be a markdown document.
    return undefined;
  }
  const prefix = `${subdirPrefix}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
}

// No-op (returns the full array) when neither limit nor offset is given, so
// internal callers that want everything keep working unchanged.
function paginate<T>(items: T[], options?: { limit?: number; offset?: number }): T[] {
  if (!options || (options.limit === undefined && options.offset === undefined)) {
    return items;
  }

  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit ?? items.length;
  return items.slice(offset, offset + limit);
}

async function findMarkdownFiles(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    // A not-yet-populated destination subpath has no directory on disk; treat
    // it as an empty index rather than crashing the caller (e.g. publish).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: string[] = [];

  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules") {
      continue;
    }

    const fullPath = path.join(root, entry);
    const entryStat = await stat(fullPath);
    if (entryStat.isDirectory()) {
      files.push(...(await findMarkdownFiles(fullPath)));
      continue;
    }

    if (entryStat.isFile() && entry.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

// Returns the top `limit` items by `compare` without fully sorting the input.
// A bounded insertion into a small array beats an O(N log N) sort of every
// candidate when only a handful of results are kept (limit << N).
function selectTopK<T>(items: T[], limit: number, compare: (left: T, right: T) => number): T[] {
  if (limit <= 0) {
    return [];
  }
  if (items.length <= limit) {
    return [...items].sort(compare);
  }

  const top: T[] = [];
  for (const item of items) {
    if (top.length < limit) {
      // Keep the buffer sorted (best first) so the weakest kept item is last.
      const at = lowerBound(top, item, compare);
      top.splice(at, 0, item);
      continue;
    }
    // Replace the current weakest only if this item ranks ahead of it.
    if (compare(item, top[top.length - 1]) < 0) {
      const at = lowerBound(top, item, compare);
      top.splice(at, 0, item);
      top.pop();
    }
  }
  return top;
}

// First index in the sorted `items` where `value` is not strictly better, per `compare`.
function lowerBound<T>(items: T[], value: T, compare: (left: T, right: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compare(items[mid], value) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function scoreSection(section: DocumentSection, terms: string[]): number {
  const haystack = `${section.heading} ${section.content}`.toLowerCase();
  return terms.reduce((score, term) => {
    if (!haystack.includes(term)) {
      return score;
    }

    return score + (section.heading.toLowerCase().includes(term) ? 3 : 1);
  }, 0);
}

function tokenize(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((term) => !stopwords.has(term)))];
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || randomUUID();
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

const stopwords = new Set([
  "and",
  "are",
  "for",
  "how",
  "the",
  "this",
  "that",
  "what",
  "when",
  "where",
  "who",
  "why",
  "with"
]);

function resolveLocalPath(value: string): string {
  if (path.isAbsolute(value)) {
    return value;
  }

  const bases = [process.env.INIT_CWD, process.cwd(), path.resolve(process.cwd(), "../..")].filter(
    (base): base is string => Boolean(base)
  );
  for (const base of bases) {
    const candidate = path.resolve(base, value);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

async function detectGitContext(localPath: string): Promise<GitRepositoryContext> {
  const indexedPath = path.resolve(localPath);
  const workTreeRoot = await readGitValue(indexedPath, ["rev-parse", "--show-toplevel"]);
  if (!workTreeRoot) {
    return {
      scope: "not-git",
      indexedPath
    };
  }

  const normalizedIndexedPath = normalizePathForComparison(indexedPath);
  const normalizedWorkTreeRoot = normalizePathForComparison(workTreeRoot);
  const relativePathFromRoot = toPosixPath(path.relative(workTreeRoot, indexedPath));
  const remoteUrl = await readGitValue(indexedPath, ["config", "--get", "remote.origin.url"]);
  const defaultBranchRef = await readGitValue(indexedPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD"
  ]);
  const defaultBranch = defaultBranchRef?.replace(/^origin\//, "");
  const status = await readGitValue(indexedPath, ["status", "--porcelain"]);

  return {
    scope: normalizedIndexedPath === normalizedWorkTreeRoot ? "repository-root" : "subdirectory",
    indexedPath,
    workTreeRoot,
    relativePathFromRoot: relativePathFromRoot || ".",
    currentBranch: await readGitValue(indexedPath, ["branch", "--show-current"]),
    defaultBranch,
    headSha: await readGitValue(indexedPath, ["rev-parse", "HEAD"]),
    remoteUrl,
    hasUncommittedChanges: Boolean(status)
  };
}

async function readGitValue(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", args, { cwd });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function normalizePathForComparison(value: string): string {
  return path
    .resolve(value)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}
