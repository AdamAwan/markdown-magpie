import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { resetData } from "../features/config/service.js";
import { makeTestContext } from "../test-support/context.js";
import { InMemoryQuestionLogStore } from "./question-log-store.js";
import { InMemoryProposalStore } from "./proposal-store.js";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";
import { InMemoryKnowledgeIndex } from "./knowledge-index.js";

test("resetData clears domain stores and resets the job queue", async () => {
  // resetData re-derives runtime config from the environment via ctx.config.reset().
  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "codex";

  const ctx = makeTestContext();
  await ctx.stores.questionLogs.record({
    question: "How do I adopt a cat?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.jobs.create("trigger_scheduled_crunch", { flowId: "default" });

  let reset = false;
  const originalReset = ctx.jobs.reset.bind(ctx.jobs);
  ctx.jobs.reset = async () => {
    reset = true;
    await originalReset();
  };

  try {
    await resetData(ctx);
  } finally {
    if (previousProvider === undefined) {
      delete process.env.AI_PROVIDER;
    } else {
      process.env.AI_PROVIDER = previousProvider;
    }
  }

  assert.equal(reset, true, "ctx.jobs.reset() should be called");
  assert.deepEqual(await ctx.stores.questionLogs.list(50), []);
  assert.deepEqual((await ctx.jobs.list({})).jobs, []);
  // Reconcile ran against the now-empty settings, so no schedules remain.
  assert.deepEqual(await ctx.jobs.listSchedules(), []);
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
