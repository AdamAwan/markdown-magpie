import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryAiJobQueue } from "./ai-job-queue.js";
import { InMemoryQuestionLogStore } from "./question-log-store.js";
import { InMemoryProposalStore } from "./proposal-store.js";

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
    executionMode: "direct",
    chatProvider: "mock",
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
