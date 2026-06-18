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
