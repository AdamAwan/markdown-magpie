import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestContext } from "../../test-support/context.js";
import { ask } from "./service.js";

test("ask in direct mode returns a direct result and records an answered question log", async () => {
  const ctx = makeTestContext();

  const outcome = await ask(ctx, "How do I configure X?");

  assert.equal(outcome.kind, "direct");
  if (outcome.kind !== "direct") {
    return;
  }
  assert.equal(outcome.mode, "direct");
  assert.ok(outcome.result.answer.length > 0);

  const log = await ctx.stores.questionLogs.get(outcome.questionId);
  assert.ok(log, "question log should be recorded");
  assert.ok(log.answer, "question log should carry the answer");
  assert.equal(log.answer.answer, outcome.result.answer);

  // The empty index produces no AI job in direct mode.
  assert.equal((await ctx.jobs.list({})).jobs.length, 0);
});

test("ask in queue mode returns a queue result and enqueues an answer_question job", async () => {
  const ctx = makeTestContext();
  const error = ctx.config.update({ aiExecutionMode: "queue", aiProvider: "mock" });
  assert.equal(error, undefined, "mock provider should support queue mode");

  const outcome = await ask(ctx, "How do I configure X?");

  assert.equal(outcome.kind, "queue");
  if (outcome.kind !== "queue") {
    return;
  }

  const { jobs } = await ctx.jobs.list({});
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, "answer_question");
  assert.equal(jobs[0].id, outcome.job.id);

  // The question log is recorded up front in queue mode, without an answer yet.
  const log = await ctx.stores.questionLogs.get(outcome.questionId);
  assert.ok(log);
  assert.equal(log.answer, undefined);
});
