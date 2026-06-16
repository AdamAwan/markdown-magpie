import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AnswerQuestionJobInput,
  AnswerQuestionJobOutput,
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput
} from "@magpie/core";
import { makeTestContext } from "../../test-support/context.js";
import { completeJob } from "./service.js";

test("completeJob on a draft_markdown_proposal job creates a proposal", async () => {
  const ctx = makeTestContext();

  const input: DraftMarkdownProposalJobInput = {
    gapSummaries: ["How to configure X"],
    triggeringQuestions: ["How do I configure X?"],
    evidence: [],
    expectedOutput: "markdown_proposal"
  };
  const job = await ctx.stores.aiJobs.enqueue("draft_markdown_proposal", input);

  const output: DraftMarkdownProposalJobOutput = {
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r"
  };

  const result = await completeJob(ctx, job.id, output);
  assert.equal(result.ok, true);

  const created = await ctx.stores.proposals.list(50);
  assert.equal(created.length, 1);
  assert.equal(created[0].title, "Configure X");
  assert.equal(created[0].jobId, job.id);
});

test("completeJob on an answer_question job updates the question log with the answer", async () => {
  const ctx = makeTestContext();

  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    executionMode: "queue",
    chatProvider: "mock",
    retrievedSectionIds: []
  });

  const input: AnswerQuestionJobInput = {
    questionLogId: log.id,
    question: "How do I configure X?",
    context: [],
    expectedOutput: "answer_result"
  };
  const job = await ctx.stores.aiJobs.enqueue("answer_question", input);

  const output: AnswerQuestionJobOutput = {
    answer: "Set the X flag in config.",
    confidence: "high",
    citations: []
  };

  const result = await completeJob(ctx, job.id, output);
  assert.equal(result.ok, true);

  const updated = await ctx.stores.questionLogs.get(log.id);
  assert.ok(updated);
  assert.ok(updated.answer);
  assert.equal(updated.answer.answer, "Set the X flag in config.");
  assert.equal(updated.confidence, "high");
});

test("completeJob with an unknown job id returns the job_not_found sentinel", async () => {
  const ctx = makeTestContext();

  const result = await completeJob(ctx, "bogus", undefined);

  assert.deepEqual(result, { ok: false, code: "job_not_found" });
});
