import { test } from "node:test";
import assert from "node:assert/strict";
import { jobDefinition } from "@magpie/jobs";
import { RuntimeConfigHolder } from "../../config-holder.js";
import { makeTestContext } from "../../test-support/context.js";
import { ask } from "./service.js";

test("ask enqueues a catalog-valid answer_question job and records an unanswered log", async () => {
  const ctx = makeTestContext();
  ctx.config = new RuntimeConfigHolder({ aiExecutionMode: "queue", aiProvider: "openai-compatible" });

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
  ctx.config = new RuntimeConfigHolder({ aiExecutionMode: "queue", aiProvider: "openai-compatible" });
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
  ctx.config = new RuntimeConfigHolder({ aiExecutionMode: "queue", aiProvider: "openai-compatible" });

  await ask(ctx, "How do I configure X?");

  const { jobs } = await ctx.jobs.list({});
  const input = jobs[0].input as { flows: unknown[] };
  assert.deepEqual(input.flows, []);
});
