import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { InMemoryAiJobQueue } from "./ai-job-queue.js";
import { InMemoryQuestionLogStore } from "./question-log-store.js";
import { InMemoryProposalStore } from "./proposal-store.js";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";
import { InMemoryKnowledgeIndex } from "./knowledge-index.js";

test("InMemoryAiJobQueue.reset removes all jobs", async () => {
  const queue = new InMemoryAiJobQueue();
  await queue.enqueue("answer_question", { question: "hi" });
  await queue.enqueue("answer_question", { question: "there" });

  await queue.reset();

  assert.deepEqual(await queue.list(), []);
});

test("InMemoryQuestionLogStore.reset removes all questions", async () => {
  const store = new InMemoryQuestionLogStore();
  await store.record({
    question: "How do I adopt a cat?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });

  await store.reset();

  assert.deepEqual(await store.list(50), []);
});

test("InMemoryProposalStore.reset removes all proposals", async () => {
  const store = new InMemoryProposalStore();
  await store.create({
    title: "Add cat care guide",
    targetPath: "cats/care.md",
    markdown: "# Care",
    rationale: "Frequently asked",
    evidence: []
  });

  await store.reset();

  assert.deepEqual(await store.list(50), []);
});

test("InMemoryKnowledgeIndex.reset empties the index stats", async () => {
  const index = new InMemoryKnowledgeIndex();
  await index.indexMarkdownDocuments({
    repositoryId: "cats",
    name: "Cats",
    documents: [{ path: "care.md", content: "# Care\n\nFeed the cat." }]
  });
  assert.ok(index.getStats().sectionCount > 0);

  index.reset();

  assert.deepEqual(index.getStats(), { repositoryCount: 0, documentCount: 0, sectionCount: 0 });
});

const databaseUrl = process.env.DATABASE_URL;

describe("PostgresKnowledgeStore.reset", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  it("clears knowledge tables without error", async () => {
    const store = new PostgresKnowledgeStore(databaseUrl as string);
    await store.reset();
    const loaded = await store.loadAll();
    assert.deepEqual(loaded.repositories, []);
    assert.deepEqual(loaded.documents, []);
    assert.deepEqual(loaded.sections, []);
  });
});
