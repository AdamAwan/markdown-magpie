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

describe("PostgresKnowledgeStore embedding carry-forward", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  // A 1536-dim unit vector: the schema's embedding column is vector(1536).
  const vector = (seed: number): number[] => {
    const v = new Array<number>(1536).fill(0);
    v[0] = seed;
    return v;
  };

  const buildDoc = (
    repositoryId: string,
    p: string,
    sectionContents: string[]
  ): { document: KnowledgeDocument; sections: DocumentSection[] } => {
    const document: KnowledgeDocument = {
      id: `${repositoryId}:${p}`,
      repositoryId,
      path: p,
      metadata: { title: p, status: "draft", tags: [], relatedDocs: [] },
      content: sectionContents.join("\n")
    };
    const sections: DocumentSection[] = sectionContents.map((content, ordinal) => ({
      id: `${document.id}:${ordinal}`,
      documentId: document.id,
      path: p,
      heading: `${p}#${ordinal}`,
      headingPath: [p],
      anchor: String(ordinal),
      content,
      ordinal
    }));
    return { document, sections };
  };

  const repositoryRef = (repositoryId: string): IndexedRepositorySummary["repository"] => ({
    id: repositoryId,
    name: repositoryId,
    defaultBranch: "main",
    localPath: "/tmp",
    provider: "local"
  });

  it("keeps embeddings for unchanged sections and resets only changed ones on full re-index", async () => {
    const store = new PostgresKnowledgeStore(makeTestPool(databaseUrl as string));
    const repositoryId = `carry-full-${Date.now()}`;
    const repository = repositoryRef(repositoryId);

    const first = buildDoc(repositoryId, "doc.md", ["alpha", "bravo", "charlie"]);
    await store.saveIndexedRepository(
      { repository, documentCount: 1, sectionCount: first.sections.length },
      [first.document],
      first.sections
    );

    // Embed all three sections, then confirm none are pending.
    await store.saveSectionEmbeddings(first.sections.map((s) => ({ id: s.id, embedding: vector(1) })));
    assert.equal(await store.countSectionsNeedingEmbedding(repositoryId), 0);

    // Re-index the same doc with only the middle section's content changed.
    const second = buildDoc(repositoryId, "doc.md", ["alpha", "bravo CHANGED", "charlie"]);
    await store.saveIndexedRepository(
      { repository, documentCount: 1, sectionCount: second.sections.length },
      [second.document],
      second.sections
    );

    // Exactly the changed section (ordinal 1) is now missing its embedding; the
    // two unchanged sections carried their vectors forward.
    const pending = await store.listSectionsNeedingEmbedding(10, repositoryId);
    assert.deepEqual(
      pending.map((s) => s.id),
      [`${repositoryId}:doc.md:1`]
    );
  });

  it("carries embeddings forward for untouched sections on incremental re-index", async () => {
    const store = new PostgresKnowledgeStore(makeTestPool(databaseUrl as string));
    const repositoryId = `carry-incr-${Date.now()}`;
    const repository = repositoryRef(repositoryId);

    const seed = buildDoc(repositoryId, "doc.md", ["one", "two", "three"]);
    await store.saveIndexedRepository(
      { repository, documentCount: 1, sectionCount: seed.sections.length, commitSha: "sha-1" },
      [seed.document],
      seed.sections
    );
    await store.saveSectionEmbeddings(seed.sections.map((s) => ({ id: s.id, embedding: vector(2) })));
    assert.equal(await store.countSectionsNeedingEmbedding(repositoryId), 0);

    // Incremental: the doc changes so its last section's text differs, and a
    // fourth section is appended. Sections 0 and 1 are byte-identical.
    const changed = buildDoc(repositoryId, "doc.md", ["one", "two", "three CHANGED", "four"]);
    await store.applyIncrementalIndex({
      repository,
      commitSha: "sha-2",
      upsertedDocuments: [changed.document],
      upsertedSections: changed.sections,
      deletedDocumentIds: []
    });

    // Only the changed section (ordinal 2) and the brand-new one (ordinal 3) need
    // embedding; ordinals 0 and 1 kept their vectors.
    const pending = await store.listSectionsNeedingEmbedding(10, repositoryId);
    assert.deepEqual(
      pending.map((s) => s.id).sort(),
      [`${repositoryId}:doc.md:2`, `${repositoryId}:doc.md:3`]
    );
  });

  it("carries the embedding_model stamp forward with the vector and clears both on change", async () => {
    const store = new PostgresKnowledgeStore(makeTestPool(databaseUrl as string), "openai-compatible:model-a");
    const repositoryId = `carry-model-${Date.now()}`;
    const repository = repositoryRef(repositoryId);

    const first = buildDoc(repositoryId, "doc.md", ["alpha", "bravo"]);
    await store.saveIndexedRepository(
      { repository, documentCount: 1, sectionCount: first.sections.length },
      [first.document],
      first.sections
    );
    await store.saveSectionEmbeddings(first.sections.map((s) => ({ id: s.id, embedding: vector(1) })));
    assert.equal(await store.countSectionsNeedingEmbedding(repositoryId), 0);

    // Re-index with only the second section changed: the first keeps its vector
    // AND its model stamp (so it still isn't pending), the second resets both.
    const second = buildDoc(repositoryId, "doc.md", ["alpha", "bravo CHANGED"]);
    await store.saveIndexedRepository(
      { repository, documentCount: 1, sectionCount: second.sections.length },
      [second.document],
      second.sections
    );
    const pending = await store.listSectionsNeedingEmbedding(10, repositoryId);
    assert.deepEqual(
      pending.map((s) => s.id),
      [`${repositoryId}:doc.md:1`]
    );
  });

  it("deletes sections dropped from a shrinking document", async () => {
    const store = new PostgresKnowledgeStore(makeTestPool(databaseUrl as string));
    const repositoryId = `carry-shrink-${Date.now()}`;
    const repository = repositoryRef(repositoryId);

    const before = buildDoc(repositoryId, "doc.md", ["s0", "s1", "s2"]);
    await store.saveIndexedRepository(
      { repository, documentCount: 1, sectionCount: before.sections.length },
      [before.document],
      before.sections
    );

    // Re-index with only the first section remaining.
    const after = buildDoc(repositoryId, "doc.md", ["s0"]);
    await store.saveIndexedRepository(
      { repository, documentCount: 1, sectionCount: after.sections.length },
      [after.document],
      after.sections
    );

    const loaded = await store.loadAll();
    const ids = loaded.sections
      .filter((s) => s.documentId === `${repositoryId}:doc.md`)
      .map((s) => s.id)
      .sort();
    assert.deepEqual(ids, [`${repositoryId}:doc.md:0`]);
  });
});

describe("PostgresKnowledgeStore embedding-model versioning", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const MODEL_A = "openai-compatible:model-a";
  const MODEL_B = "openai-compatible:model-b";

  const vector = (seed: number): number[] => {
    const v = new Array<number>(1536).fill(0);
    v[0] = seed;
    return v;
  };

  const seedRepo = async (store: PostgresKnowledgeStore, repositoryId: string): Promise<{ sectionId: string }> => {
    const document: KnowledgeDocument = {
      id: `${repositoryId}:doc.md`,
      repositoryId,
      path: "doc.md",
      metadata: { title: "doc.md", status: "draft", tags: [], relatedDocs: [] },
      content: "# doc\nbody\n"
    };
    const section: DocumentSection = {
      id: `${document.id}:0`,
      documentId: document.id,
      path: "doc.md",
      heading: "doc",
      headingPath: ["doc"],
      anchor: "0",
      content: "body",
      ordinal: 0
    };
    await store.saveIndexedRepository(
      {
        repository: { id: repositoryId, name: repositoryId, defaultBranch: "main", localPath: "/tmp", provider: "local" },
        documentCount: 1,
        sectionCount: 1
      },
      [document],
      [section]
    );
    return { sectionId: section.id };
  };

  it("vector search only matches vectors produced by the configured model", async () => {
    const pool = makeTestPool(databaseUrl as string);
    const storeA = new PostgresKnowledgeStore(pool, MODEL_A);
    const repositoryId = `model-guard-${Date.now()}`;
    const { sectionId } = await seedRepo(storeA, repositoryId);
    await storeA.saveSectionEmbeddings([{ id: sectionId, embedding: vector(1) }]);

    // Same model: the vector is comparable and the section is found.
    const sameModel = await storeA.searchByEmbedding(vector(1), 10, [repositoryId]);
    assert.deepEqual(sameModel.map((hit) => hit.id), [sectionId]);

    // A store configured with a different model must not see model-a vectors.
    const storeB = new PostgresKnowledgeStore(pool, MODEL_B);
    const otherModel = await storeB.searchByEmbedding(vector(1), 10, [repositoryId]);
    assert.deepEqual(otherModel, []);

    // An unversioned store (no embeddings configured) keeps the legacy
    // behaviour of matching every stored vector.
    const unversioned = new PostgresKnowledgeStore(pool);
    const legacy = await unversioned.searchByEmbedding(vector(1), 10, [repositoryId]);
    assert.deepEqual(legacy.map((hit) => hit.id), [sectionId]);
  });

  it("treats a model mismatch as needing re-embedding, and re-embedding restores search", async () => {
    const pool = makeTestPool(databaseUrl as string);
    const storeA = new PostgresKnowledgeStore(pool, MODEL_A);
    const repositoryId = `model-reembed-${Date.now()}`;
    const { sectionId } = await seedRepo(storeA, repositoryId);
    await storeA.saveSectionEmbeddings([{ id: sectionId, embedding: vector(1) }]);
    assert.equal(await storeA.countSectionsNeedingEmbedding(repositoryId), 0);

    // Under model B the stored vector is stale: the section is pending again.
    const storeB = new PostgresKnowledgeStore(pool, MODEL_B);
    assert.equal(await storeB.countSectionsNeedingEmbedding(repositoryId), 1);
    const pending = await storeB.listSectionsNeedingEmbedding(10, repositoryId);
    assert.deepEqual(pending.map((s) => s.id), [sectionId]);

    // Re-embedding under model B clears the backlog and makes the section
    // visible to model-B vector search again.
    await storeB.saveSectionEmbeddings([{ id: sectionId, embedding: vector(2) }]);
    assert.equal(await storeB.countSectionsNeedingEmbedding(repositoryId), 0);
    const hits = await storeB.searchByEmbedding(vector(2), 10, [repositoryId]);
    assert.deepEqual(hits.map((hit) => hit.id), [sectionId]);
  });

  it("adopts pre-versioning vectors under the configured model instead of re-embedding", async () => {
    const pool = makeTestPool(databaseUrl as string);
    // An unversioned store writes a NULL-stamped vector, exactly like data
    // saved before the embedding_model column existed.
    const unversioned = new PostgresKnowledgeStore(pool);
    const repositoryId = `model-adopt-${Date.now()}`;
    const { sectionId } = await seedRepo(unversioned, repositoryId);
    await unversioned.saveSectionEmbeddings([{ id: sectionId, embedding: vector(3) }]);

    const storeA = new PostgresKnowledgeStore(pool, MODEL_A);
    assert.equal(await storeA.countSectionsNeedingEmbedding(repositoryId), 1, "unadopted legacy vector reads as stale");

    const adopted = await storeA.adoptUnversionedEmbeddings();
    assert.ok(adopted >= 1, "at least this test's legacy vector is adopted");
    assert.equal(await storeA.countSectionsNeedingEmbedding(repositoryId), 0, "adoption avoids a re-embed");
    const hits = await storeA.searchByEmbedding(vector(3), 10, [repositoryId]);
    assert.deepEqual(hits.map((hit) => hit.id), [sectionId]);

    // Adoption on an unversioned store is a no-op by definition.
    assert.equal(await unversioned.adoptUnversionedEmbeddings(), 0);
  });
});
