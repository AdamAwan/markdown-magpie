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
