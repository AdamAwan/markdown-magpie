import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AnswerQuestionJobOutput,
  CrunchPlan,
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput
} from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import { makeTestContext } from "../../test-support/context.js";
import {
  cancelJob,
  claimJob,
  completeJob,
  failJob,
  getJob,
  heartbeatJob,
  listJobs,
  projectJob,
  retryJob,
  waitForJob
} from "./service.js";

const answerInput = (provider: "codex" | "openai-compatible" = "codex") => ({
  provider,
  question: "How?",
  flows: [],
  expectedOutput: "answer_result" as const
});

test("job services filter lists and isolate claims by capability", async () => {
  const ctx = makeTestContext();
  const codex = await ctx.jobs.create("answer_question", answerInput());
  await ctx.jobs.create("answer_question", answerInput("openai-compatible"));

  const listed = await listJobs(ctx, { type: "answer_question", state: "created", limit: 1 });
  assert.equal(listed.total, 2);
  assert.equal(listed.jobs.length, 1);
  assert.equal((await claimJob(ctx, "codex-worker", ["codex"]))?.id, codex.id);
  assert.equal(await claimJob(ctx, "codex-worker", ["codex"]), undefined);
});

test("heartbeat, cancellation, and failed-only retry expose lifecycle state", async () => {
  const ctx = makeTestContext();
  const created = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);
  assert.equal((await heartbeatJob(ctx, created.id)).state, "active");
  assert.equal((await cancelJob(ctx, created.id)).state, "cancelled");
  assert.equal((await heartbeatJob(ctx, created.id)).state, "cancelled");
  await assert.rejects(() => retryJob(ctx, created.id), /only "?failed/i);

  const failed = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);
  for (let attempt = 0; attempt <= failed.retryLimit; attempt += 1) {
    await failJob(ctx, failed.id, { code: "provider", message: "failed", category: "provider" });
  }
  assert.equal((await retryJob(ctx, failed.id)).state, "created");
});

test("wait returns current jobs on timeout and terminal jobs immediately", async () => {
  const ctx = makeTestContext();
  const created = await ctx.jobs.create("answer_question", answerInput());
  const pending = await waitForJob(ctx, created.id, { timeoutMs: 10, pollMs: 1 });
  assert.equal(pending.terminal, false);
  assert.equal(pending.job.state, "created");
  await ctx.jobs.cancel(created.id);
  const terminal = await waitForJob(ctx, created.id, { timeoutMs: 10, pollMs: 1 });
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.job.state, "cancelled");
});

test("display projection recursively redacts secrets without mutating stored input", () => {
  const input = { apiKey: "a", nested: [{ token: "b", authorization: "c" }], password: "d", safe: "ok" };
  const job: JobView = {
    id: "job", type: "refresh_pull_requests", queueName: "refresh_pull_requests", deadLetter: false,
    state: "created", input, retryCount: 0, retryLimit: 1, expireInSeconds: 60,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const projected = projectJob(job);
  assert.deepEqual(projected.input, {
    apiKey: "[redacted]", nested: [{ token: "[redacted]", authorization: "[redacted]" }],
    password: "[redacted]", safe: "ok"
  });
  assert.equal(input.apiKey, "a");
});

test("proposal completion is idempotent when delivered twice", async () => {
  const ctx = makeTestContext();

  const validInput: DraftMarkdownProposalJobInput & { provider: "codex" } = {
    provider: "codex",
    gapSummaries: ["How to configure X"],
    triggeringQuestions: ["How do I configure X?"],
    evidence: [],
    expectedOutput: "markdown_proposal"
  };
  const job = await ctx.jobs.create("draft_markdown_proposal", validInput);

  const output: DraftMarkdownProposalJobOutput = {
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r"
  };

  const result = await completeJob(ctx, job.id, output);
  assert.equal(result.ok, true);
  const first = (await ctx.stores.proposals.list(50))[0];
  const repeated = await completeJob(ctx, job.id, output);
  assert.equal(repeated.ok, true);

  const created = await ctx.stores.proposals.list(50);
  assert.equal(created.length, 1);
  assert.equal(created[0].id, first.id);
  assert.equal(created[0].title, "Configure X");
  assert.equal(created[0].jobId, job.id);
});

test("publish_proposal completion records publication and is idempotent when delivered twice", async () => {
  const ctx = makeTestContext();

  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.updateStatus(proposal.id, "ready");

  const job = await ctx.jobs.create("publish_proposal", { proposalId: proposal.id });

  const output = {
    proposalId: proposal.id,
    branchName: "magpie/proposal-abc-configure-x",
    commitSha: "deadbeef",
    remoteUrl: "https://github.com/o/r.git",
    pullRequestUrl: "https://github.com/o/r/pull/9",
    publishedAt: new Date().toISOString()
  };

  assert.equal((await completeJob(ctx, job.id, output)).ok, true);

  const published = await ctx.stores.proposals.get(proposal.id);
  assert.ok(published);
  assert.equal(published.status, "pr-opened");
  assert.equal(published.publication?.branchName, output.branchName);
  assert.equal(published.publication?.commitSha, output.commitSha);
  assert.equal(published.publication?.remoteUrl, output.remoteUrl);
  assert.equal(published.publication?.pullRequestUrl, output.pullRequestUrl);
  assert.equal(published.publication?.publishedAt, output.publishedAt);

  // Re-completing the same job must not change the recorded publication.
  assert.equal((await completeJob(ctx, job.id, output)).ok, true);
  const repeated = await ctx.stores.proposals.get(proposal.id);
  assert.equal(repeated?.publication?.publishedAt, output.publishedAt);
});

test("refresh_pull_requests completion applies merged/closed transitions idempotently", async () => {
  const ctx = makeTestContext();

  const mergedProposal = await ctx.stores.proposals.create({
    title: "Merged one",
    targetPath: "a.md",
    markdown: "# A",
    rationale: "r",
    evidence: [],
    triggeringQuestionIds: ["q1"],
    gapSummary: "gap a"
  });
  await ctx.stores.proposals.recordPublication(mergedProposal.id, {
    provider: "local-git",
    branchName: "magpie/proposal-a",
    commitSha: "sha",
    pullRequestUrl: "https://github.com/o/r/pull/1",
    publishedAt: new Date().toISOString()
  });

  const closedProposal = await ctx.stores.proposals.create({
    title: "Closed one",
    targetPath: "b.md",
    markdown: "# B",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.recordPublication(closedProposal.id, {
    provider: "local-git",
    branchName: "magpie/proposal-b",
    commitSha: "sha",
    pullRequestUrl: "https://github.com/o/r/pull/2",
    publishedAt: new Date().toISOString()
  });

  // Count cascades by observing gap resolution: a merged proposal resolves its gaps.
  let resolveCalls = 0;
  const realResolve = ctx.stores.questionLogs.resolveGaps.bind(ctx.stores.questionLogs);
  ctx.stores.questionLogs.resolveGaps = async (questionIds: string[], summaries: string[], proposalId: string) => {
    resolveCalls += 1;
    return realResolve(questionIds, summaries, proposalId);
  };

  const job = await ctx.jobs.create("refresh_pull_requests", {});
  const output = {
    results: [
      { proposalId: mergedProposal.id, state: "closed" as const, merged: true },
      { proposalId: closedProposal.id, state: "closed" as const, merged: false }
    ]
  };

  assert.equal((await completeJob(ctx, job.id, output)).ok, true);
  assert.equal((await ctx.stores.proposals.get(mergedProposal.id))?.status, "merged");
  assert.equal((await ctx.stores.proposals.get(closedProposal.id))?.status, "rejected");
  const cascadesAfterFirst = resolveCalls;

  // Re-completing the same job must converge: no second cascade, statuses unchanged.
  const job2 = await ctx.jobs.create("refresh_pull_requests", {});
  assert.equal((await completeJob(ctx, job2.id, output)).ok, true);
  assert.equal((await ctx.stores.proposals.get(mergedProposal.id))?.status, "merged");
  assert.equal((await ctx.stores.proposals.get(closedProposal.id))?.status, "rejected");
  assert.equal(resolveCalls, cascadesAfterFirst, "merge cascade must not run a second time");
});

test("answer completion is idempotent when delivered twice", async () => {
  const ctx = makeTestContext();

  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    executionMode: "queue",
    chatProvider: "mock",
    retrievedSectionIds: []
  });

  const input = {
    provider: "codex" as const,
    questionLogId: log.id,
    question: "How do I configure X?",
    flows: [],
    expectedOutput: "answer_result" as const
  };
  const job = await ctx.jobs.create("answer_question", input);

  const output: AnswerQuestionJobOutput = {
    answer: "Set the X flag in config.",
    confidence: "high",
    citations: []
  };

  const result = await completeJob(ctx, job.id, output);
  assert.equal(result.ok, true);
  const repeated = await completeJob(ctx, job.id, output);
  assert.equal(repeated.ok, true);

  const updated = await ctx.stores.questionLogs.get(log.id);
  assert.ok(updated);
  assert.ok(updated.answer);
  assert.equal(updated.answer.answer, "Set the X flag in config.");
  assert.equal(updated.confidence, "high");
});

test("answer completion persists the routed flowId and retrieved section ids on the log", async () => {
  const ctx = makeTestContext();

  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    executionMode: "queue",
    chatProvider: "openai-compatible",
    retrievedSectionIds: []
  });

  const job = await ctx.jobs.create("answer_question", {
    provider: "openai-compatible" as const,
    questionLogId: log.id,
    question: "How do I configure X?",
    flows: [{ id: "support", name: "Support" }],
    expectedOutput: "answer_result" as const
  });

  const output: AnswerQuestionJobOutput = {
    answer: "Set the X flag in config.",
    confidence: "high",
    flowId: "support",
    citations: [
      {
        documentId: "doc-1",
        sectionId: "support-kb:configure.md:0",
        path: "configure.md",
        heading: "Configure",
        anchor: "configure",
        excerpt: "Set the X flag."
      }
    ]
  };

  assert.equal((await completeJob(ctx, job.id, output)).ok, true);

  const updated = await ctx.stores.questionLogs.get(log.id);
  assert.ok(updated);
  assert.equal(updated.flowId, "support");
  assert.deepEqual(updated.retrievedSectionIds, ["support-kb:configure.md:0"]);
});

test("source-sync publication completion records the publication once and is idempotent", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("publish_source_sync", { runId: "placeholder" });
  const run = await ctx.stores.sourceSync.createRun({
    destinationId: "dest",
    sourceId: "src-1",
    trigger: "scheduled",
    status: "completed",
    plan: { summary: "s", operations: [], rationale: "r" },
    changeset: [{ path: "guide.md", content: "x" }],
    toSha: "abc",
    changedFileCount: 1,
    candidateCount: 1
  });

  const output = {
    runId: run.id,
    branchName: "magpie/source-sync-" + run.id.slice(0, 8),
    commitSha: "deadbeef",
    remoteUrl: "https://github.com/acme/docs.git",
    publishedAt: "2026-01-01T00:00:00.000Z"
  };

  assert.equal((await completeJob(ctx, job.id, output)).ok, true);
  const first = await ctx.stores.sourceSync.getRun(run.id);
  assert.equal(first?.status, "published");
  assert.equal(first?.publication?.commitSha, "deadbeef");
  assert.equal(first?.publication?.branchName, output.branchName);

  // Re-completing the same job (or a duplicate delivery) must not double-apply or
  // regress the recorded publication.
  assert.equal((await completeJob(ctx, job.id, output)).ok, true);
  const repeated = await ctx.stores.sourceSync.getRun(run.id);
  assert.equal(repeated?.status, "published");
  assert.deepEqual(repeated?.publication, first?.publication);
});

test("crunch completion is idempotent when delivered twice", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("crunch_knowledge_base", {
    provider: "codex", documents: [], expectedOutput: "crunch_plan"
  });
  const run = await ctx.stores.crunchRuns.createRun({
    trigger: "manual", documentCount: 0, jobId: job.id, status: "running"
  });
  const plan: CrunchPlan = { summary: "done", operations: [], rationale: "tidy" };
  assert.equal((await completeJob(ctx, job.id, plan)).ok, true);
  const first = await ctx.stores.crunchRuns.getRun(run.id);
  assert.equal((await completeJob(ctx, job.id, plan)).ok, true);
  const repeated = await ctx.stores.crunchRuns.getRun(run.id);
  assert.equal(repeated?.status, "completed");
  assert.equal(repeated?.completedAt, first?.completedAt);
});

test("publish_crunch completion records publication on the run and is idempotent when delivered twice", async () => {
  const ctx = makeTestContext();
  const run = await ctx.stores.crunchRuns.createRun({
    trigger: "manual", documentCount: 1, status: "running"
  });
  await ctx.stores.crunchRuns.completeRun(run.id, { summary: "s", operations: [], rationale: "r" });

  const job = await ctx.jobs.create("publish_crunch", { runId: run.id });

  const output = {
    runId: run.id,
    branchName: "magpie/crunch-abc",
    commitSha: "deadbeef",
    remoteUrl: "https://github.com/o/r.git",
    publishedAt: new Date().toISOString()
  };

  assert.equal((await completeJob(ctx, job.id, output)).ok, true);

  const published = await ctx.stores.crunchRuns.getRun(run.id);
  assert.ok(published);
  assert.equal(published.status, "published");
  assert.equal(published.publication?.branchName, output.branchName);
  assert.equal(published.publication?.commitSha, output.commitSha);
  assert.equal(published.publication?.remoteUrl, output.remoteUrl);
  assert.equal(published.publication?.publishedAt, output.publishedAt);

  // Re-completing the same job must not change the recorded publication.
  assert.equal((await completeJob(ctx, job.id, output)).ok, true);
  const repeated = await ctx.stores.crunchRuns.getRun(run.id);
  assert.equal(repeated?.publication?.publishedAt, output.publishedAt);
});

test("retryable crunch failure does not fail the linked run", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("crunch_knowledge_base", {
    provider: "codex", documents: [], expectedOutput: "crunch_plan"
  });
  const run = await ctx.stores.crunchRuns.createRun({
    trigger: "manual", documentCount: 0, jobId: job.id, status: "running"
  });
  await failJob(ctx, job.id, { code: "provider", message: "temporary", category: "provider" });
  assert.equal((await ctx.stores.crunchRuns.getRun(run.id))?.status, "running");
});

test("completeJob with an unknown job id returns the job_not_found sentinel", async () => {
  const ctx = makeTestContext();

  const result = await completeJob(ctx, "bogus", undefined);

  assert.deepEqual(result, { ok: false, code: "job_not_found" });
});

test("completeJob validates catalog output and rejects completion after cancellation", async () => {
  const ctx = makeTestContext();
  const invalid = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);
  const invalidResult = await completeJob(ctx, invalid.id, { answer: "missing contract fields" });
  assert.deepEqual(invalidResult, { ok: false, code: "invalid_output" });
  assert.equal((await getJob(ctx, invalid.id))?.state, "retry");

  const cancelled = await ctx.jobs.create("answer_question", answerInput());
  await cancelJob(ctx, cancelled.id);
  const cancelledResult = await completeJob(ctx, cancelled.id, {
    answer: "no", confidence: "high", citations: []
  });
  assert.deepEqual(cancelledResult, { ok: false, code: "job_cancelled" });
});
