import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../../app.js";
import type { AppContext } from "../../context.js";
import { makeTestContext } from "../../test-support/context.js";
import { sweepUnsettledFailures } from "./failure-sweep.js";
import { claimJob, completeJob, failJob, heartbeatJob, retryJob } from "./service.js";

// Lost and stuck work in the job lifecycle: the attempt fence (J60), the
// completion that did not persist (J62), terminal-failure settlement (J63–J65),
// and the routes' 404-vs-500 split (API31).

const answerInput = () => ({ provider: "codex", question: "Q?", flows: [], expectedOutput: "answer_result" });
const answer = { answer: "A", confidence: "high", citations: [] };
const providerError = { code: "provider", message: "provider error", category: "provider" } as const;

// A fold job whose terminal failure has an observable side effect: the rival
// proposal is queued to publish on its own (foldService.enqueueFoldFallback).
async function foldJob(ctx: AppContext): Promise<{ jobId: string; rivalId: string }> {
  const rival = await ctx.stores.proposals.create({
    title: "B",
    targetPath: "kb/refunds.md",
    markdown: "# rival",
    rationale: "r",
    evidence: []
  });
  const job = await ctx.jobs.create("fold_markdown_proposal", {
    provider: "codex",
    survivorProposalId: "missing",
    rivalProposalId: rival.id,
    targetPath: "kb/refunds.md",
    survivorMarkdown: "x",
    rivalMarkdown: "y",
    rivalGapSummaries: [],
    rivalEvidence: [],
    expectedOutput: "folded_markdown"
  });
  return { jobId: job.id, rivalId: rival.id };
}

async function fallbackCount(ctx: AppContext, rivalId: string): Promise<number> {
  return (await ctx.stores.gapClusters.listPendingPublicationActions()).filter(
    (action) => action.proposalId === rivalId && action.kind === "publish"
  ).length;
}

test("J60: a heartbeat from a lapsed attempt reports the job no longer held", async () => {
  const ctx = makeTestContext();
  const created = await ctx.jobs.create("answer_question", answerInput());
  const first = await claimJob(ctx, "w1", ["codex"]);
  assert.equal((await heartbeatJob(ctx, created.id, "w1", { attempt: first!.retryCount })).active, true);

  // The claim lapses (the queue fails it back to retry) and another watcher re-claims.
  await ctx.jobs.fail(created.id, providerError);
  const second = await claimJob(ctx, "w2", ["codex"]);
  assert.notEqual(second!.retryCount, first!.retryCount);

  assert.equal((await heartbeatJob(ctx, created.id, "w1", { attempt: first!.retryCount })).active, false);
  assert.equal((await heartbeatJob(ctx, created.id, "w2", { attempt: second!.retryCount })).active, true);
});

test("J62: a completion that does not persist returns job_not_active and runs no side effects", async () => {
  const ctx = makeTestContext();
  const created = await ctx.jobs.create("answer_question", {
    ...answerInput(),
    questionLogId: (
      await ctx.stores.questionLogs.record({ question: "Q?", chatProvider: "codex", retrievedSectionIds: [] })
    ).id
  });
  const first = await claimJob(ctx, "w1", ["codex"]);
  await ctx.jobs.fail(created.id, providerError);
  await claimJob(ctx, "w2", ["codex"]);

  const outcome = await completeJob(ctx, created.id, answer, "w1", undefined, undefined, {
    attempt: first!.retryCount
  });
  assert.deepEqual(outcome, { ok: false, code: "job_not_active" });
  assert.equal((await ctx.jobs.get(created.id))?.state, "active", "the newer attempt keeps the job");
  const log = await ctx.stores.questionLogs.get((created.input as { questionLogId: string }).questionLogId);
  assert.equal(log?.answer, undefined, "no side effect ran for the stale completion");
});

test("J61: a lapsed attempt's completion is salvaged while nobody has re-claimed the job", async () => {
  const ctx = makeTestContext();
  const created = await ctx.jobs.create("answer_question", answerInput());
  const first = await claimJob(ctx, "w1", ["codex"]);
  await ctx.jobs.fail(created.id, providerError); // lapsed back to retry, not re-claimed

  const outcome = await completeJob(ctx, created.id, answer, "w1", undefined, undefined, {
    attempt: first!.retryCount
  });
  assert.equal(outcome.ok, true);
  assert.equal((await ctx.jobs.get(created.id))?.state, "completed");
});

test("J62 route: a completion that did not persist is a 409 job_not_active", async () => {
  const ctx = makeTestContext();
  const created = await ctx.jobs.create("answer_question", answerInput());
  const first = await claimJob(ctx, "w1", ["codex"]);
  await ctx.jobs.fail(created.id, providerError);
  await claimJob(ctx, "w2", ["codex"]);
  const res = await buildApp(ctx).request(`/api/jobs/${created.id}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ output: answer, executor: "w1", attempt: first!.retryCount })
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "job_not_active" });
});

test("J64: a terminal failure's side effects run once, however many times it is reported", async () => {
  const ctx = makeTestContext();
  const { jobId, rivalId } = await foldJob(ctx);
  await ctx.jobs.claim("w", ["codex"]);
  await failJob(ctx, jobId, providerError, { terminal: true });
  await failJob(ctx, jobId, providerError, { terminal: true });
  assert.equal(await sweepUnsettledFailures(ctx), 0, "nothing left for the sweep");
  assert.equal(await fallbackCount(ctx, rivalId), 1);
});

test("J63: the sweep settles a job the queue failed by itself, exactly once", async () => {
  const ctx = makeTestContext();
  const { jobId, rivalId } = await foldJob(ctx);
  await ctx.jobs.claim("w", ["codex"]);
  // pg-boss failing a job itself (expiry, heartbeat loss) reaches the broker
  // directly — no API fail route, so no side effects yet.
  await ctx.jobs.failTerminal(jobId, { code: "job_expired", message: "job timed out", category: "timeout" });
  assert.equal(await fallbackCount(ctx, rivalId), 0);

  assert.equal(await sweepUnsettledFailures(ctx), 1);
  assert.equal(await fallbackCount(ctx, rivalId), 1);
  assert.equal(await sweepUnsettledFailures(ctx), 0, "a settled failure is never swept again");
  // A duplicate fail report after the sweep is a no-op too.
  await failJob(ctx, jobId, providerError);
  assert.equal(await fallbackCount(ctx, rivalId), 1);
});

test("J64: side effects that throw leave the failure unsettled for the next sweep", async () => {
  const ctx = makeTestContext();
  const { jobId, rivalId } = await foldJob(ctx);
  await ctx.jobs.claim("w", ["codex"]);
  await ctx.jobs.failTerminal(jobId, providerError);

  const original = ctx.stores.gapClusters.enqueuePublicationAction.bind(ctx.stores.gapClusters);
  ctx.stores.gapClusters.enqueuePublicationAction = async () => {
    throw new Error("store down");
  };
  assert.equal(await sweepUnsettledFailures(ctx), 0);
  ctx.stores.gapClusters.enqueuePublicationAction = original;
  assert.equal(await sweepUnsettledFailures(ctx), 1);
  assert.equal(await fallbackCount(ctx, rivalId), 1);
});

test("J65: a manually retried job's next terminal failure settles again", async () => {
  const ctx = makeTestContext();
  const { jobId } = await foldJob(ctx);
  await ctx.jobs.claim("w", ["codex"]);
  await failJob(ctx, jobId, providerError, { terminal: true });
  await retryJob(ctx, jobId);
  await ctx.jobs.claim("w", ["codex"]);
  await ctx.jobs.failTerminal(jobId, providerError);
  assert.equal(await sweepUnsettledFailures(ctx), 1);
});

test("API31: lifecycle routes answer 404 only for an unknown job, 500 for a real error", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const missing = "00000000-0000-4000-8000-000000000000";
  assert.equal((await post(`/api/jobs/${missing}/heartbeat`, {})).status, 404);
  assert.equal((await post(`/api/jobs/${missing}/fail`, { error: providerError })).status, 404);

  const created = await ctx.jobs.create("answer_question", answerInput());
  ctx.jobs.heartbeat = async () => {
    throw new Error("database unavailable");
  };
  ctx.jobs.fail = async () => {
    throw new Error("database unavailable");
  };
  assert.equal((await post(`/api/jobs/${created.id}/heartbeat`, {})).status, 500);
  assert.equal((await post(`/api/jobs/${created.id}/fail`, { error: providerError })).status, 500);
});
