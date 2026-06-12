import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DocumentSection, KnowledgeDocument, RepositoryRef } from "@magpie/core";
import { parseMarkdownDocument, splitIntoSections } from "@magpie/markdown";

const execFileAsync = promisify(execFile);

export interface IndexedRepositorySummary {
  repository: RepositoryRef;
  documentCount: number;
  sectionCount: number;
  commitSha?: string;
}

export interface KnowledgePersistence {
  saveIndexedRepository(summary: IndexedRepositorySummary, documents: KnowledgeDocument[], sections: DocumentSection[]): Promise<void>;
}

export interface MarkdownUpload {
  path: string;
  content: string;
}

export class InMemoryKnowledgeIndex {
  private readonly documents = new Map<string, KnowledgeDocument>();
  private readonly sections = new Map<string, DocumentSection>();
  private readonly repositories = new Map<string, RepositoryRef>();

  constructor(private readonly persistence?: KnowledgePersistence) {}

  async indexLocalRepository(input: {
    localPath: string;
    repositoryId?: string;
    name?: string;
  }): Promise<IndexedRepositorySummary> {
    const localPath = resolveLocalPath(input.localPath);
    const repository: RepositoryRef = {
      id: input.repositoryId ?? slugify(path.basename(localPath)),
      name: input.name ?? path.basename(localPath),
      defaultBranch: "main",
      localPath,
      provider: "local"
    };
    const commitSha = await readGitHead(localPath);
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

  async search(question: string, limit: number): Promise<DocumentSection[]> {
    const terms = tokenize(question);
    if (terms.length === 0) {
      return [];
    }

    return [...this.sections.values()]
      .map((section) => ({
        section,
        score: scoreSection(section, terms)
      }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((result) => result.section);
  }

  listDocuments(): KnowledgeDocument[] {
    return [...this.documents.values()].sort((left, right) => left.path.localeCompare(right.path));
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

async function readGitHead(localPath: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: localPath });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
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
