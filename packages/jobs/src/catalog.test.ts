import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_PROVIDERS,
  JOB_TYPES,
  allQueueDefinitions,
  jobDefinition,
  queueNameForJob,
  queueNamesForCapabilities
} from "./index.js";

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

test("every job type is unique and has schemas and a valid policy", () => {
  assert.equal(new Set(JOB_TYPES).size, JOB_TYPES.length);

  for (const type of JOB_TYPES) {
    const definition = jobDefinition(type);
    assert.equal(definition.type, type);
    assert.equal(typeof definition.inputSchema.safeParse, "function");
    assert.equal(typeof definition.outputSchema.safeParse, "function");
    assert.ok(definition.policy.retryLimit >= 0);
    assert.ok(definition.policy.heartbeatSeconds >= 10);
    assert.ok(definition.policy.expireInSeconds > definition.policy.heartbeatSeconds);
    assert.equal(definition.policy.deleteAfterSeconds, THIRTY_DAYS_SECONDS);
  }
});

test("codex capability can only claim codex-partitioned AI work", () => {
  const definition = jobDefinition("answer_question");
  assert.equal(definition.requiredCapability({ provider: "codex" }), "codex");
  assert.equal(definition.queueName({ provider: "codex" }), "answer_question__codex");

  const queues = queueNamesForCapabilities(["codex"]);

  assert.ok(queues.includes("answer_question__codex"));
  assert.ok(!queues.includes("answer_question__openai_compatible"));
  assert.equal(queueNameForJob("answer_question", { provider: "codex" }), "answer_question__codex");
});

test("github capability yields only GitHub work queues", () => {
  assert.deepEqual(queueNamesForCapabilities(["github"]), [
    "refresh_pull_requests",
    "publish_proposal",
    "publish_crunch"
  ]);
});

test("all queue definitions provision every AI provider partition and a dead-letter queue", () => {
  for (const provider of AI_PROVIDERS) {
    const queueName = queueNameForJob("answer_question", { provider });
    const definition = allQueueDefinitions.find((candidate) => candidate.name === queueName);
    assert.ok(definition);
    assert.equal(definition.capability, provider);
    assert.equal(definition.deadLetter, false);
    assert.ok(definition.policy?.deadLetter);
    assert.ok(
      allQueueDefinitions.some(
        (candidate) => candidate.name === definition.policy?.deadLetter && candidate.deadLetter
      )
    );
  }

  const claimable = queueNamesForCapabilities([...AI_PROVIDERS, "github", "maintenance"]);
  assert.ok(claimable.every((name) => !name.endsWith("__dead_letter")));
});

test("queue naming rejects a missing or invalid AI provider", () => {
  assert.throws(() => queueNameForJob("answer_question", {}), /provider/i);
  assert.throws(
    () => queueNameForJob("answer_question", { provider: "mock" as never }),
    /provider/i
  );
});
