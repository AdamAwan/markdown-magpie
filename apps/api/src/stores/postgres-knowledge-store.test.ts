import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DocumentSection, KnowledgeDocument } from "@magpie/core";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";
import type { IndexedRepositorySummary } from "./knowledge-index.js";

const databaseUrl = process.env.DATABASE_URL;

describe("PostgresKnowledgeStore vector search", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  it("counts sections needing an embedding without error", async () => {
    const store = new PostgresKnowledgeStore(databaseUrl as string);
    const pending = await store.countSectionsNeedingEmbedding();
    assert.ok(pending >= 0);
  });
});

describe("PostgresKnowledgeStore re-index pruning", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  it("removes documents absent from the new source set", async () => {
    const store = new PostgresKnowledgeStore(databaseUrl as string);
    const repositoryId = `prune-test-${Date.now()}`;
    const summary = (paths: string[]): { summary: IndexedRepositorySummary; documents: KnowledgeDocument[]; sections: DocumentSection[] } => {
      const documents: KnowledgeDocument[] = paths.map((path) => ({
        id: `${repositoryId}:${path}`,
        repositoryId,
        path,
        metadata: { title: path, status: "draft", tags: [], relatedDocs: [] },
        content: `# ${path}\nbody\n`
      }));
      const sections: DocumentSection[] = documents.map((document, ordinal) => ({
        id: `${document.id}:0`,
        documentId: document.id,
        path: document.path,
        heading: document.path,
        headingPath: [document.path],
        anchor: "0",
        content: "body",
        ordinal
      }));
      return {
        summary: {
          repository: {
            id: repositoryId,
            name: repositoryId,
            defaultBranch: "main",
            localPath: "/tmp",
            provider: "local"
          },
          documentCount: documents.length,
          sectionCount: sections.length
        },
        documents,
        sections
      };
    };

    const first = summary(["keep.md", "gone.md"]);
    await store.saveIndexedRepository(first.summary, first.documents, first.sections);

    const second = summary(["keep.md"]);
    await store.saveIndexedRepository(second.summary, second.documents, second.sections);

    const loaded = await store.loadAll();
    const paths = loaded.documents.filter((document) => document.repositoryId === repositoryId).map((document) => document.path);
    assert.deepEqual(paths.sort(), ["keep.md"]);
  });
});

describe("PostgresKnowledgeStore keyword search", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  it("ranks sections by full-text relevance and respects the repository scope", async () => {
    const store = new PostgresKnowledgeStore(databaseUrl as string);
    const repositoryId = `kw-test-${Date.now()}`;
    const otherRepositoryId = `kw-other-${Date.now()}`;

    const build = (
      repo: string,
      docPath: string,
      heading: string,
      content: string
    ): { summary: IndexedRepositorySummary; documents: KnowledgeDocument[]; sections: DocumentSection[] } => {
      const document: KnowledgeDocument = {
        id: `${repo}:${docPath}`,
        repositoryId: repo,
        path: docPath,
        metadata: { title: heading, status: "draft", tags: [], relatedDocs: [] },
        content: `# ${heading}\n${content}\n`
      };
      const section: DocumentSection = {
        id: `${document.id}:0`,
        documentId: document.id,
        path: docPath,
        heading,
        headingPath: [heading],
        anchor: "0",
        content,
        ordinal: 0
      };
      return {
        summary: {
          repository: { id: repo, name: repo, defaultBranch: "main", localPath: "/tmp", provider: "local" },
          documentCount: 1,
          sectionCount: 1
        },
        documents: [document],
        sections: [section]
      };
    };

    const rollback = build(repositoryId, "rollback.md", "Hotfix Rollback", "Run the rollback workflow and notify the incident lead.");
    const unrelated = build(repositoryId, "felines.md", "Grooming", "Sticky residue is removed with oil before bathing.");
    const otherRepo = build(otherRepositoryId, "rollback.md", "Hotfix Rollback", "Run the rollback workflow elsewhere.");

    await store.saveIndexedRepository(rollback.summary, rollback.documents, rollback.sections);
    await store.saveIndexedRepository(unrelated.summary, unrelated.documents, unrelated.sections);
    await store.saveIndexedRepository(otherRepo.summary, otherRepo.documents, otherRepo.sections);

    const scoped = await store.searchByKeyword("how do I rollback the hotfix", 10, [repositoryId]);
    assert.ok(scoped.length >= 1, "expected at least one keyword hit");
    assert.equal(scoped[0].id, `${repositoryId}:rollback.md:0`);
    assert.ok(scoped[0].relevance > 0 && scoped[0].relevance <= 1);
    assert.ok(scoped.every((hit) => hit.id.startsWith(`${repositoryId}:`)), "scope must exclude the other repository");

    const empty = await store.searchByKeyword("   ", 10, [repositoryId]);
    assert.deepEqual(empty, []);
  });
});
