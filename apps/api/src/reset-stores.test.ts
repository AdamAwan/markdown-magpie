import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryAiJobQueue } from "./ai-job-queue.js";

test("InMemoryAiJobQueue.reset removes all jobs", async () => {
  const queue = new InMemoryAiJobQueue();
  await queue.enqueue("answer_question", { question: "hi" });
  await queue.enqueue("answer_question", { question: "there" });

  await queue.reset();

  assert.deepEqual(await queue.list(), []);
});
