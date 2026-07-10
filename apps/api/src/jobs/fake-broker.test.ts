import { test } from "node:test";
import assert from "node:assert/strict";
import type { JobError } from "@magpie/jobs";
import { FakeJobBroker } from "./fake-broker.js";

// A valid answer_question input per the @magpie/jobs answerQuestionInputSchema:
// provider (enum), question (string), flows (array), expectedOutput (literal)
const validAnswerInput = {
  provider: "codex" as const,
  question: "How do I configure X?",
  flows: [],
  expectedOutput: "answer_result" as const
};

const testError: JobError = {
  code: "provider_error",
  message: "The provider returned an error",
  category: "provider"
};

test("fake broker supports create, claim, heartbeat, complete, cancel, and retry", async () => {
  const broker = new FakeJobBroker();
  const created = await broker.create("answer_question", validAnswerInput);
  const claimed = await broker.claim("worker-1", ["codex"]);
  assert.equal(claimed?.id, created.id);
  assert.equal((await broker.heartbeat(created.id)).state, "active");
  await broker.fail(created.id, testError);
  assert.equal((await broker.get(created.id))?.state, "retry");
  await broker.cancel(created.id);
  assert.equal((await broker.get(created.id))?.state, "cancelled");
});

// Mirrors the real broker's interactive lane (#240): a live ask enqueued after
// background fan-out is still the first job a watcher claims.
test("claim hands out interactive-class jobs before older background work", async () => {
  const broker = new FakeJobBroker();
  const proposal = await broker.create("draft_markdown_proposal", {
    provider: "codex" as const,
    gapSummaries: ["gap"],
    triggeringQuestions: ["question"],
    evidence: [],
    sources: [],
    expectedOutput: "markdown_proposal" as const
  });
  const answer = await broker.create("answer_question", validAnswerInput);

  const first = await broker.claim("worker-1", ["codex"]);
  assert.equal(first?.id, answer.id);
  const second = await broker.claim("worker-1", ["codex"]);
  assert.equal(second?.id, proposal.id);
});

// Mirrors pg-boss's cancelJobs SQL (`WHERE state < 'completed'`): cancelling a job
// that already reached a terminal state must be a no-op, not an overwrite. This
// is what makes runJobToCompletion's timeout-cancel (#162) race-safe against a
// job that completes in the gap between the bounded wait giving up and the
// cancel call actually reaching the broker.
test("cancel is a no-op once a job has already completed", async () => {
  const broker = new FakeJobBroker();
  const created = await broker.create("answer_question", validAnswerInput);
  await broker.claim("worker-1", ["codex"]);
  const output = { answer: "done", confidence: "high" as const, citations: [] };
  const completed = await broker.complete(created.id, output);
  assert.equal(completed.state, "completed");

  const cancelled = await broker.cancel(created.id);
  assert.equal(cancelled.state, "completed");
  assert.deepEqual(cancelled.output, output);
  assert.equal((await broker.get(created.id))?.state, "completed");
});
