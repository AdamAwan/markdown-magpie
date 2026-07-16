import { test } from "node:test";
import assert from "node:assert/strict";
import { jobDefinition } from "@magpie/jobs";
import { RuntimeConfigHolder } from "../../config-holder.js";
import { HttpError } from "../../http/errors.js";
import { makeTestContext } from "../../test-support/context.js";
import { ask } from "./service.js";

test("ask enqueues a catalog-valid answer_question job and records an unanswered log", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });

  const outcome = await ask(ctx, "How do I configure X?");

  const { jobs } = await ctx.jobs.list({});
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.type, "answer_question");
  assert.equal(job.id, outcome.job.id);
  assert.equal(job.state, "created");

  // The enqueued input must satisfy the job contract (the broker validates it,
  // but assert explicitly so the test pins the contract shape).
  const parsed = jobDefinition("answer_question").inputSchema.safeParse(job.input);
  assert.ok(parsed.success, "enqueued input should match the answer_question contract");

  // The question log is recorded up front, without an answer yet.
  const log = await ctx.stores.questionLogs.get(outcome.questionId);
  assert.ok(log);
  assert.equal(log.answer, undefined);
});

test("ask populates routing flows from the configured knowledge flows", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  ctx.knowledgeConfig.flows = [
    { id: "support", name: "Support", sourceIds: ["s"], destinationId: "kb", persona: "Be kind" },
    { id: "eng", name: "Engineering", sourceIds: ["s"], destinationId: "kb2" }
  ];

  await ask(ctx, "How do I configure X?");

  const { jobs } = await ctx.jobs.list({});
  const input = jobs[0].input as { flows: Array<{ id: string; name: string; persona?: string }> };
  assert.deepEqual(input.flows, [
    { id: "support", name: "Support", persona: "Be kind" },
    { id: "eng", name: "Engineering" }
  ]);
});

test("ask emits an empty flows array when no flows are configured", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });

  await ask(ctx, "How do I configure X?");

  const { jobs } = await ctx.jobs.list({});
  const input = jobs[0].input as { flows: unknown[] };
  assert.deepEqual(input.flows, []);
});

test("ask pins a caller-specified flow as requestedFlowId", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  ctx.knowledgeConfig.flows = [{ id: "support", name: "Support", sourceIds: ["s"], destinationId: "kb" }];

  await ask(ctx, "How do I configure X?", "support");

  const { jobs } = await ctx.jobs.list({});
  const input = jobs[0].input as { requestedFlowId?: string };
  assert.equal(input.requestedFlowId, "support");
});

test('ask treats absent and "auto" as routing (no requestedFlowId)', async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  ctx.knowledgeConfig.flows = [{ id: "support", name: "Support", sourceIds: ["s"], destinationId: "kb" }];

  await ask(ctx, "How do I configure X?", "auto");

  const { jobs } = await ctx.jobs.list({});
  const input = jobs[0].input as { requestedFlowId?: string };
  assert.equal(input.requestedFlowId, undefined);
});

// Seeds an answered live turn in a conversation, so a follow-up can reconstruct it.
async function seedTurn(
  ctx: ReturnType<typeof makeTestContext>,
  conversationId: string,
  question: string,
  answerText: string,
  flowId?: string
): Promise<void> {
  const log = await ctx.stores.questionLogs.record({
    question,
    chatProvider: "openai-compatible",
    retrievedSectionIds: [],
    purpose: "live",
    conversationId
  });
  await ctx.stores.questionLogs.updateAnswer(log.id, {
    answer: { answer: answerText, confidence: "high", citations: [] },
    ...(flowId ? { flowId } : {})
  });
}

test("ask mints and returns a conversationId, with no prior turns on the first ask", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });

  const outcome = await ask(ctx, "How do I configure X?");

  assert.match(outcome.conversationId, /^[0-9a-f-]{36}$/, "a UUID conversation id is returned");
  const { jobs } = await ctx.jobs.list({});
  const input = jobs[0].input as { priorTurns?: unknown; conversationFlowId?: unknown };
  assert.equal(input.priorTurns, undefined, "the first turn carries no prior context");
  assert.equal(input.conversationFlowId, undefined);

  // The recorded log is tagged with the returned conversation id.
  const log = await ctx.stores.questionLogs.get(outcome.questionId);
  assert.equal(log?.conversationId, outcome.conversationId);
});

test("ask on a follow-up assembles prior turns and the conversation's sticky flow", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  ctx.knowledgeConfig.flows = [{ id: "support", name: "Support", sourceIds: ["s"], destinationId: "kb" }];

  const conversationId = "11111111-1111-4111-8111-111111111111";
  await seedTurn(ctx, conversationId, "What is the data retention policy?", "Retention is 30 days.", "support");

  const outcome = await ask(ctx, "What about the EU?", undefined, conversationId);

  assert.equal(outcome.conversationId, conversationId, "the follow-up stays on the same conversation");
  const { jobs } = await ctx.jobs.list({});
  const followup = jobs.find((j) => (j.input as { question?: string }).question === "What about the EU?");
  const input = followup!.input as {
    priorTurns?: Array<{ question: string; answer: string }>;
    conversationFlowId?: string;
    requestedFlowId?: string;
  };
  assert.deepEqual(input.priorTurns, [
    { question: "What is the data retention policy?", answer: "Retention is 30 days." }
  ]);
  assert.equal(input.conversationFlowId, "support", "the prior turn's flow becomes the sticky flow");
  assert.equal(input.requestedFlowId, undefined, "no explicit pin on an auto follow-up");
});

test("an explicit flow on a follow-up wins over the conversation's sticky flow", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  ctx.knowledgeConfig.flows = [
    { id: "support", name: "Support", sourceIds: ["s"], destinationId: "kb" },
    { id: "eng", name: "Engineering", sourceIds: ["s"], destinationId: "kb2" }
  ];

  const conversationId = "22222222-2222-4222-8222-222222222222";
  await seedTurn(ctx, conversationId, "How do I deploy?", "Run the script.", "support");

  await ask(ctx, "and in staging?", "eng", conversationId);

  const { jobs } = await ctx.jobs.list({});
  const followup = jobs.find((j) => (j.input as { question?: string }).question === "and in staging?");
  const input = followup!.input as { requestedFlowId?: string; conversationFlowId?: string };
  assert.equal(input.requestedFlowId, "eng", "the caller's explicit flow is pinned");
  assert.equal(input.conversationFlowId, undefined, "the sticky flow is not sent when the caller pinned one");
});

test("ask bounds a follow-up's prior turns to the most recent N", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });

  const conversationId = "33333333-3333-4333-8333-333333333333";
  for (let index = 0; index < 9; index += 1) {
    await seedTurn(ctx, conversationId, `Q${index}`, `A${index}`);
  }

  await ask(ctx, "final follow-up", undefined, conversationId);

  const { jobs } = await ctx.jobs.list({});
  const followup = jobs.find((j) => (j.input as { question?: string }).question === "final follow-up");
  const input = followup!.input as { priorTurns?: Array<{ question: string }> };
  assert.ok(input.priorTurns, "prior turns are attached");
  assert.equal(input.priorTurns.length, 6, "only the last N (6) turns are carried");
  assert.equal(input.priorTurns[0].question, "Q3", "the oldest retained turn is the 6th-from-last");
  assert.equal(input.priorTurns.at(-1)?.question, "Q8", "the newest retained turn is last, oldest-first");
});

test("ask rejects an unknown flow id with a 400", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiProvider: "openai-compatible" });
  ctx.knowledgeConfig.flows = [{ id: "support", name: "Support", sourceIds: ["s"], destinationId: "kb" }];

  await assert.rejects(
    () => ask(ctx, "How do I configure X?", "marketing"),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "unknown_flow");
      return true;
    }
  );

  // Nothing should be enqueued when validation fails.
  const { jobs } = await ctx.jobs.list({});
  assert.equal(jobs.length, 0);
});
