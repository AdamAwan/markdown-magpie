import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DocumentSection, EmbeddingProvider, GitRepositoryContext, KnowledgeDocument, RankedSection, RepositoryRef } from "@magpie/core";
import { parseMarkdownDocument, splitIntoSections } from "@magpie/markdown";
import { fuseRankings } from "@magpie/retrieval";

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
  searchByEmbedding(embedding: number[], limit: number): Promise<Array<{ id: string; similarity: number }>>;
}

export interface SectionToEmbed {
  id: string;
  text: string;
}

export interface EmbeddingPersistence {
  listSectionsNeedingEmbedding(limit: number, repositoryId?: string): Promise<SectionToEmbed[]>;
  countSectionsNeedingEmbedding(repositoryId?: string): Promise<number>;
  saveSectionEmbedding(id: string, embedding: number[]): Promise<void>;
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

export interface HybridSearchOptions {
  embeddingProvider?: EmbeddingProvider;
  vectorSearch?: SectionVectorSearch;
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
    const documents: KnowledgeDocument[] = [];
    const sections: DocumentSection[] = [];

    for (const markdownPath of markdownPaths) {
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

      documents.push(document);
      sections.push(...splitIntoSections(document));
    }

    this.repositories.set(repository.id, repository);
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
    for (const document of documents) {
      this.documents.set(document.id, document);
      for (const [sectionId, section] of this.sections) {
        if (section.documentId === document.id) {
          this.sections.delete(sectionId);
        }
      }
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

  async search(question: string, limit: number): Promise<RankedSection[]> {
    const keywordRanked = this.keywordRank(question);

    const { embeddingProvider, vectorSearch, onNotice } = this.hybrid;
    if (!embeddingProvider || !vectorSearch) {
      return keywordRanked.slice(0, limit);
    }

    let vectorHits: Array<{ id: string; similarity: number }>;
    try {
      const [queryVector] = await embeddingProvider.embed([question]);
      vectorHits = await vectorSearch.searchByEmbedding(queryVector, Math.max(limit, VECTOR_CANDIDATES));
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

    return [...new Set([...vectorIds, ...keywordIds])]
      .map((id) => ({
        id,
        fused: fused.get(id) ?? 0,
        relevance: Math.max(similarityById.get(id) ?? 0, keywordRelevanceById.get(id) ?? 0)
      }))
      .sort((left, right) => right.fused - left.fused)
      .slice(0, limit)
      .map(({ id, relevance }) => {
        const section = this.sections.get(id);
        return section ? { section, relevance } : undefined;
      })
      .filter((result): result is RankedSection => result !== undefined);
  }

  private keywordRank(question: string): RankedSection[] {
    const terms = tokenize(question);
    if (terms.length === 0) {
      return [];
    }

    return [...this.sections.values()]
      .map((section) => ({ section, score: scoreSection(section, terms) }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((result) => ({
        section: result.section,
        relevance: Math.min(1, result.score / KEYWORD_RELEVANCE_SCALE)
      }));
  }

  listDocuments(): KnowledgeDocument[] {
    return [...this.documents.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  listRepositories(): RepositoryRef[] {
    return [...this.repositories.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  getStats(): { repositoryCount: number; documentCount: number; sectionCount: number } {
    return {
      repositoryCount: this.repositories.size,
      documentCount: this.documents.size,
      sectionCount: this.sections.size
    };
  }
}

async function findMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root);
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
  return path.resolve(value).replace(/[\\\/]+$/, "").toLowerCase();
}
