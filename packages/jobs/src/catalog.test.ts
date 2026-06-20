import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_PROVIDERS,
  JOB_TYPES,
  allQueueDefinitions,
  answerQuestionInputSchema,
  answerQuestionOutputSchema,
  jobDefinition,
  queueNameForJob,
  queueNamesForCapabilities
} from "./index.js";

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const FOURTEEN_DAYS_SECONDS = 14 * 24 * 60 * 60;
const EXPIRATION_SECONDS = {
  answer_question: 5 * 60,
  summarize_gap: 10 * 60,
  draft_markdown_proposal: 15 * 60,
  detect_contradiction: 10 * 60,
  suggest_consolidation: 10 * 60,
  crunch_knowledge_base: 60 * 60,
  cluster_gap_candidates: 5 * 60,
  refresh_pull_requests: 5 * 60,
  process_gaps_to_pull_requests: 60 * 60,
  trigger_scheduled_crunch: 60 * 60,
  publish_proposal: 15 * 60,
  publish_crunch: 15 * 60
} as const;

test("every job type is unique and has schemas and a valid policy", () => {
  assert.equal(new Set(JOB_TYPES).size, JOB_TYPES.length);

  for (const type of JOB_TYPES) {
    const definition = jobDefinition(type);
    assert.equal(definition.type, type);
    assert.equal(typeof definition.inputSchema.safeParse, "function");
    assert.equal(typeof definition.outputSchema.safeParse, "function");
    assert.equal(definition.policy.heartbeatSeconds, 60);
    assert.equal(definition.policy.retentionSeconds, FOURTEEN_DAYS_SECONDS);
    assert.equal(definition.policy.expireInSeconds, EXPIRATION_SECONDS[type]);
    assert.ok(definition.policy.expireInSeconds > definition.policy.heartbeatSeconds);
    assert.equal(definition.policy.deleteAfterSeconds, THIRTY_DAYS_SECONDS);
    assert.equal(definition.policy.retryBackoff, true);
  }
});

test("provider work retries three times and non-provider work retries twice", () => {
  for (const type of ["answer_question", "cluster_gap_candidates"] as const) {
    const policy = jobDefinition(type).policy;
    assert.equal(policy.retryLimit, 3);
    assert.equal(policy.retryDelay, 15);
    assert.equal(policy.retryDelayMax, 300);
  }
  for (const type of ["process_gaps_to_pull_requests", "refresh_pull_requests"] as const) {
    const policy = jobDefinition(type).policy;
    assert.equal(policy.retryLimit, 2);
    assert.equal(policy.retryDelay, 30);
    assert.equal(policy.retryDelayMax, 600);
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
  const queueDefinitions = allQueueDefinitions();
  for (const provider of AI_PROVIDERS) {
    const queueName = queueNameForJob("answer_question", { provider });
    const definition = queueDefinitions.find((candidate) => candidate.name === queueName);
    assert.ok(definition);
    assert.equal(definition.capability, provider);
    assert.equal(definition.deadLetter, false);
    assert.ok(definition.policy?.deadLetter);
    assert.ok(
      queueDefinitions.some(
        (candidate) => candidate.name === definition.policy?.deadLetter && candidate.deadLetter
      )
    );
  }

  const claimable = queueNamesForCapabilities([...AI_PROVIDERS, "github", "maintenance"]);
  assert.ok(claimable.every((name) => !name.endsWith("__dead_letter")));
});

test("every concrete work and dead-letter queue name is unique", () => {
  const names = allQueueDefinitions().map((definition) => definition.name);
  assert.equal(new Set(names).size, names.length);
});

test("answer_question input carries routing flows, not pre-retrieved context", () => {
  const valid = answerQuestionInputSchema.safeParse({
    provider: "openai-compatible",
    questionLogId: "log-1",
    question: "How do I configure X?",
    flows: [{ id: "flow-1", name: "Support", persona: "You are helpful" }, { id: "flow-2", name: "Eng" }],
    expectedOutput: "answer_result"
  });
  assert.ok(valid.success, "flows-based input should be accepted");

  const emptyFlows = answerQuestionInputSchema.safeParse({
    provider: "openai-compatible",
    question: "q",
    flows: [],
    expectedOutput: "answer_result"
  });
  assert.ok(emptyFlows.success, "empty flows should be accepted");

  const legacy = answerQuestionInputSchema.safeParse({
    provider: "openai-compatible",
    question: "q",
    context: [{ sectionId: "s", path: "p", heading: "h", content: "c" }],
    expectedOutput: "answer_result"
  });
  assert.ok(!legacy.success, "the old context-array input should be rejected (flows missing)");
});

test("answer_question output may record the routed flowId", () => {
  const withFlow = answerQuestionOutputSchema.safeParse({
    answer: "A",
    confidence: "high",
    citations: [],
    flowId: "flow-1"
  });
  assert.ok(withFlow.success, "flowId should be accepted on output");

  const withoutFlow = answerQuestionOutputSchema.safeParse({
    answer: "A",
    confidence: "high",
    citations: []
  });
  assert.ok(withoutFlow.success, "flowId is optional on output");
});

test("queue naming rejects a missing or invalid AI provider", () => {
  assert.throws(() => queueNameForJob("answer_question", {}), /provider/i);
  assert.throws(
    () => queueNameForJob("answer_question", { provider: "mock" as never }),
    /provider/i
  );
});
