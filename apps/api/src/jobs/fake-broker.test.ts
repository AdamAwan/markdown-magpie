import { test } from "node:test";
import assert from "node:assert/strict";
import type { JobError, JobType } from "@magpie/jobs";
import { FakeJobBroker } from "./fake-broker.js";

// A valid answer_question input per the @magpie/jobs answerQuestionInputSchema:
// provider (enum), question (string), flows (array), expectedOutput (literal)
const validAnswerInput = {
  provider: "codex" as const,
  question: "How do I configure X?",
  flows: [],
  expectedOutput: "answer_result" as const
};

// A valid summarize_gap (maintenance-class AI) input — counted toward the global
// ceiling but never toward the interactive reserve.
const validSummaryInput = {
  provider: "codex" as const,
  questions: ["q"],
  citedSections: [],
  expectedOutput: "gap_summary" as const
};

// Global + interactive lanes for the admission tests, mirroring the real
// AI_JOB_TYPES / INTERACTIVE_AI_JOB_TYPES split.
const globalTypes: JobType[] = ["answer_question", "summarize_gap"];
const interactiveTypes: JobType[] = ["answer_question"];

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

// createIfAdmitted mirror (#288a): the single-process fake applies the same
// count + block rule the real broker does under its advisory lock.
test("createIfAdmitted admits under the ceiling and rejects at it", async () => {
  const broker = new FakeJobBroker();
  const capacity = { types: globalTypes, limit: 2 };

  const first = await broker.createIfAdmitted("answer_question", validAnswerInput, capacity);
  assert.equal(first.admitted, true);
  assert.ok(first.job);
  assert.equal(first.inFlight, 0, "the count reflects the pre-admission figure");

  const second = await broker.createIfAdmitted("answer_question", validAnswerInput, capacity);
  assert.equal(second.admitted, true);

  const third = await broker.createIfAdmitted("answer_question", validAnswerInput, capacity);
  assert.equal(third.admitted, false);
  assert.equal(third.job, undefined);
  assert.equal(third.inFlight, 2);
  // A rejected admission enqueued nothing.
  assert.equal((await broker.list({ type: "answer_question" })).total, 2);
});

test("createIfAdmitted admits interactive work into the reserve while the global lane is full", async () => {
  const broker = new FakeJobBroker();
  const capacity = { types: globalTypes, limit: 2, reserve: { types: interactiveTypes, reserved: 1 } };

  // Two maintenance jobs fill the global ceiling without touching the reserve.
  await broker.create("summarize_gap", validSummaryInput);
  await broker.create("summarize_gap", validSummaryInput);

  const viaReserve = await broker.createIfAdmitted("answer_question", validAnswerInput, capacity);
  assert.equal(viaReserve.admitted, true, "interactive work admits via its reserve");
  assert.equal(viaReserve.reserveInFlight, 0);
});

test("createIfAdmitted rejects once both the reserve and the global lane are full", async () => {
  const broker = new FakeJobBroker();
  const capacity = { types: globalTypes, limit: 2, reserve: { types: interactiveTypes, reserved: 1 } };

  await broker.create("summarize_gap", validSummaryInput);
  await broker.createIfAdmitted("answer_question", validAnswerInput, capacity); // takes the reserve

  const rejected = await broker.createIfAdmitted("answer_question", validAnswerInput, capacity);
  assert.equal(rejected.admitted, false);
  assert.equal(rejected.inFlight, 2);
  assert.equal(rejected.reserveInFlight, 1);
});

test("createIfAdmitted enforces a single shared ceiling when no reserve is given", async () => {
  const broker = new FakeJobBroker();
  const capacity = { types: globalTypes, limit: 1 };

  const first = await broker.createIfAdmitted("summarize_gap", validSummaryInput, capacity);
  assert.equal(first.admitted, true);
  assert.equal(first.reserveInFlight, undefined, "no reserve lane means no reserve count is reported");

  const second = await broker.createIfAdmitted("answer_question", validAnswerInput, capacity);
  assert.equal(second.admitted, false);
  assert.equal(second.reserveInFlight, undefined);
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
