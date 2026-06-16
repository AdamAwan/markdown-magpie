import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryAiJobQueue } from "./ai-job-queue.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("claimNext records the claiming worker and a claim timestamp", async () => {
  const queue = new InMemoryAiJobQueue();
  await queue.enqueue("answer_question", { question: "hi" });

  const claimed = await queue.claimNext("worker-a", ["answer_question"]);

  assert.ok(claimed);
  assert.equal(claimed?.status, "claimed");
  assert.equal(claimed?.claimedBy, "worker-a");
  assert.ok(claimed?.claimedAt);
});

test("a fresh claim is not handed to a second worker", async () => {
  const queue = new InMemoryAiJobQueue(60_000);
  await queue.enqueue("answer_question", { question: "hi" });

  await queue.claimNext("worker-a", ["answer_question"]);
  const second = await queue.claimNext("worker-b", ["answer_question"]);

  assert.equal(second, undefined);
});

test("an expired claim is requeued and reclaimable by another worker", async () => {
  const queue = new InMemoryAiJobQueue(10);
  const job = await queue.enqueue("answer_question", { question: "hi" });

  const first = await queue.claimNext("worker-a", ["answer_question"]);
  assert.equal(first?.id, job.id);

  await delay(25);

  const reclaimed = await queue.claimNext("worker-b", ["answer_question"]);
  assert.equal(reclaimed?.id, job.id);
  assert.equal(reclaimed?.claimedBy, "worker-b");

  // Only ever one job in the queue, now claimed by worker-b.
  const all = await queue.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.status, "claimed");
});

test("completing a job clears it from the pending set", async () => {
  const queue = new InMemoryAiJobQueue(10);
  const job = await queue.enqueue("answer_question", { question: "hi" });

  await queue.claimNext("worker-a", ["answer_question"]);
  await queue.complete(job.id, { answer: "done", confidence: "low", citations: [] });

  await delay(25);

  // Even after the lease would have expired, a completed job is never requeued.
  const next = await queue.claimNext("worker-b", ["answer_question"]);
  assert.equal(next, undefined);
});
