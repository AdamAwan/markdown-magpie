import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DocumentSection, EmbeddingProvider, GitRepositoryContext, KnowledgeDocument, RankedSection, RepositoryRef } from "@magpie/core";
import { parseMarkdownDocument, splitIntoSections } from "@magpie/markdown";
import { fuseRankings } from "@magpie/retrieval";
import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface IndexedRepositorySummary {
  repository: RepositoryRef;
  documentCount: number;
  sectionCount: number;
  commitSha?: string;
}

export interface LoadedKnowledge {
  repositories: RepositoryRef[];
  documents: KnowledgeDocument[];
  sections: DocumentSection[];
}

export interface KnowledgePersistence {
  saveIndexedRepository(summary: IndexedRepositorySummary, documents: KnowledgeDocument[], sections: DocumentSection[]): Promise<void>;
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

    for (const repository of repositories) {
      const git = await detectGitContext(repository.localPath);
      this.repositories.set(repository.id, {
        ...repository,
        remoteUrl: repository.remoteUrl ?? git.remoteUrl,
        git
      });
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
  }): Promise<IndexedRepositorySummary> {
    const localPath = resolveLocalPath(input.localPath);
    const git = await detectGitContext(localPath);
    const repository: RepositoryRef = {
      id: input.repositoryId ?? slugify(path.basename(localPath)),
      name: input.name ?? path.basename(localPath),
      defaultBranch: git.defaultBranch ?? git.currentBranch ?? "main",
      localPath,
      provider: "local",
      remoteUrl: git.remoteUrl,
      git
    };
    const commitSha = git.headSha;
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
        chunk.map(async (markdownPath) => {
          const fileStat = await stat(markdownPath);
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
        })
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

    const summary: IndexedRepositorySummary = {
      repository,
      documentCount: documents.length,
      sectionCount: sections.length,
      commitSha
    };

    await this.persistence?.saveIndexedRepository(summary, documents, sections);
    return summary;
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
      const [queryVector] = await embeddingProvider.embed([question]);
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

    return [...new Set([...vectorIds, ...keywordIds])]
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
      .slice(0, limit);
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
  }
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
  return [
    ...new Set((value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((term) => !stopwords.has(term)))
  ];
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
  const defaultBranchRef = await readGitValue(indexedPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
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
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}
