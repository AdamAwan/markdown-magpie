import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DocumentSection, KnowledgeDocument } from "@magpie/core";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";
import type { IndexedRepositorySummary } from "./knowledge-index.js";
import { makeTestPool } from "../test-support/db-pool.js";

const databaseUrl = process.env.DATABASE_URL;

describe("PostgresKnowledgeStore vector search", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  it("counts sections needing an embedding without error", async () => {
    const store = new PostgresKnowledgeStore(makeTestPool(databaseUrl as string));
    const pending = await store.countSectionsNeedingEmbedding();
    assert.ok(pending >= 0);
  });
});

describe("PostgresKnowledgeStore re-index pruning", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  it("removes documents absent from the new source set", async () => {
    const store = new PostgresKnowledgeStore(makeTestPool(databaseUrl as string));
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
    const store = new PostgresKnowledgeStore(makeTestPool(databaseUrl as string));
    const repositoryId = `kw-test-${Date.now()}`;
    const otherRepositoryId = `kw-other-${Date.now()}`;

    // saveIndexedRepository replaces a repository's whole document set (it prunes
    // paths absent from the incoming batch), so every document for a repository
    // must be saved in a single call rather than across multiple calls.
    const buildRepo = (
      repo: string,
      docs: Array<{ path: string; heading: string; content: string }>
    ): { summary: IndexedRepositorySummary; documents: KnowledgeDocument[]; sections: DocumentSection[] } => {
      const documents: KnowledgeDocument[] = [];
      const sections: DocumentSection[] = [];
      docs.forEach((doc, ordinal) => {
        const document: KnowledgeDocument = {
          id: `${repo}:${doc.path}`,
          repositoryId: repo,
          path: doc.path,
          metadata: { title: doc.heading, status: "draft", tags: [], relatedDocs: [] },
          content: `# ${doc.heading}\n${doc.content}\n`
        };
        documents.push(document);
        sections.push({
          id: `${document.id}:0`,
          documentId: document.id,
          path: doc.path,
          heading: doc.heading,
          headingPath: [doc.heading],
          anchor: "0",
          content: doc.content,
          ordinal
        });
      });
      return {
        summary: {
          repository: { id: repo, name: repo, defaultBranch: "main", localPath: "/tmp", provider: "local" },
          documentCount: documents.length,
          sectionCount: sections.length
        },
        documents,
        sections
      };
    };

    const primary = buildRepo(repositoryId, [
      { path: "rollback.md", heading: "Hotfix Rollback", content: "Run the rollback workflow and notify the incident lead." },
      { path: "felines.md", heading: "Grooming", content: "Sticky residue is removed with oil before bathing." }
    ]);
    const otherRepo = buildRepo(otherRepositoryId, [
      { path: "rollback.md", heading: "Hotfix Rollback", content: "Run the rollback workflow elsewhere." }
    ]);

    await store.saveIndexedRepository(primary.summary, primary.documents, primary.sections);
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

describe("PostgresKnowledgeStore applyIncrementalIndex", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  it("upserts changed docs, deletes removed docs, and advances indexed_commit_sha", async () => {
    const store = new PostgresKnowledgeStore(makeTestPool(databaseUrl as string));
    const repositoryId = `incr-test-${Date.now()}`;
    const docId = (p: string): string => `${repositoryId}:${p}`;
    const makeDoc = (p: string, body: string, commitSha: string): KnowledgeDocument => ({
      id: docId(p),
      repositoryId,
      path: p,
      commitSha,
      metadata: { title: p, status: "draft", tags: [], relatedDocs: [] },
      content: body
    });
    const makeSection = (doc: KnowledgeDocument, ordinal: number, content: string): DocumentSection => ({
      id: `${doc.id}:${ordinal}`,
      documentId: doc.id,
      path: doc.path,
      heading: doc.path,
      headingPath: [doc.path],
      anchor: String(ordinal),
      content,
      ordinal
    });
    const repository = {
      id: repositoryId,
      name: repositoryId,
      defaultBranch: "main",
      localPath: "/tmp",
      provider: "local" as const
    };

    // Seed via the full-index path at commit "sha-1".
    const keep = makeDoc("keep.md", "# keep\noriginal\n", "sha-1");
    const edit = makeDoc("edit.md", "# edit\nv1\n", "sha-1");
    const remove = makeDoc("remove.md", "# remove\nbye\n", "sha-1");
    const seedDocs = [keep, edit, remove];
    const seedSections = seedDocs.map((doc, i) => makeSection(doc, 0, `body-${i}`));
    await store.saveIndexedRepository(
      { repository, documentCount: seedDocs.length, sectionCount: seedSections.length, commitSha: "sha-1" },
      seedDocs,
      seedSections
    );

    // Incremental at "sha-2": modify edit.md (with two fresh sections), delete
    // remove.md, leave keep.md untouched.
    const editV2 = makeDoc("edit.md", "# edit\nv2 changed\n", "sha-2");
    const editV2Sections = [makeSection(editV2, 0, "v2 a"), makeSection(editV2, 1, "v2 b")];
    await store.applyIncrementalIndex({
      repository,
      commitSha: "sha-2",
      upsertedDocuments: [editV2],
      upsertedSections: editV2Sections,
      deletedDocumentIds: [docId("remove.md")]
    });

    const loaded = await store.loadAll();
    const mine = loaded.documents.filter((d) => d.repositoryId === repositoryId);
    assert.deepEqual(mine.map((d) => d.path).sort(), ["edit.md", "keep.md"]);

    const loadedEdit = mine.find((d) => d.path === "edit.md");
    assert.match(loadedEdit?.content ?? "", /v2 changed/);
    assert.equal(loadedEdit?.commitSha, "sha-2", "changed doc advances to the new SHA");

    const loadedKeep = mine.find((d) => d.path === "keep.md");
    assert.equal(loadedKeep?.commitSha, "sha-1", "untouched doc keeps its original SHA");

    // edit.md's sections were replaced with the two fresh ones.
    const editSections = loaded.sections.filter((s) => s.documentId === docId("edit.md"));
    assert.equal(editSections.length, 2);

    // remove.md's sections were deleted along with the document.
    const removeSections = loaded.sections.filter((s) => s.documentId === docId("remove.md"));
    assert.equal(removeSections.length, 0);

    // The repository's indexed_commit_sha now reflects the incremental head.
    const repoRecord = loaded.repositories.find((r) => r.repository.id === repositoryId);
    assert.equal(repoRecord?.indexedCommitSha, "sha-2");
  });
});
