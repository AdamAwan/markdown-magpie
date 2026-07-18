import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type {
  AnswerQuestionJobOutput,
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput
} from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import { answerQuestionOutputSchema } from "@magpie/jobs";
import { makeTestContext } from "../../test-support/context.js";
import { logger } from "../../logger.js";
import type { AppContext } from "../../context.js";
import { completeJobBodySchema } from "./schema.js";
import {
  acceptFailedJob,
  cancelJob,
  claimJob,
  completeJob,
  failJob,
  getJob,
  heartbeatJob,
  listJobs,
  parseCompletedJobOutput,
  projectJob,
  retryJob,
  runJobToCompletion,
  strippedOutputKeyPaths,
  waitForJob,
  MaintenanceShedError
} from "./service.js";
import { createFanoutBudget } from "../../platform/maintenance-fanout.js";

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

test("connected-watcher registry tracks busy/idle across the job lifecycle", async () => {
  const ctx = makeTestContext();
  const window = 60_000;

  // An idle poll (claim with no work) registers the watcher as idle, capturing
  // the capabilities it advertised.
  assert.equal(await claimJob(ctx, "w-1", ["codex"]), undefined);
  let workers = await ctx.stores.watchers.list(window);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].name, "w-1");
  assert.equal(workers[0].status, "idle");
  assert.deepEqual(workers[0].capabilities, ["codex"]);
  assert.equal(workers[0].currentJobId, undefined);

  // Claiming a job flips it to busy on that job.
  const job = await ctx.jobs.create("answer_question", answerInput());
  assert.equal((await claimJob(ctx, "w-1", ["codex"]))?.id, job.id);
  workers = await ctx.stores.watchers.list(window);
  assert.equal(workers[0].status, "busy");
  assert.equal(workers[0].currentJobId, job.id);

  // A heartbeat keeps it busy on the same job (and is how a busy watcher stays alive).
  await heartbeatJob(ctx, job.id, "w-1");
  workers = await ctx.stores.watchers.list(window);
  assert.equal(workers[0].status, "busy");
  assert.equal(workers[0].currentJobId, job.id);

  // Completing frees the watcher; the earlier-advertised capabilities persist.
  assert.equal((await completeJob(ctx, job.id, { answer: "a", confidence: "high", citations: [] }, "w-1")).ok, true);
  workers = await ctx.stores.watchers.list(window);
  assert.equal(workers[0].status, "idle");
  assert.equal(workers[0].currentJobId, undefined);
  assert.deepEqual(workers[0].capabilities, ["codex"]);
});

test("a malformed usage reading is dropped by the body schema, never failing the completion (#241)", async () => {
  // usage is best-effort telemetry: a fractional/negative count must not 400
  // the whole complete POST (a 4xx is non-retryable on the watcher side and
  // would discard the paid-for output). The schema's .catch(undefined) drops
  // the bad reading and keeps the body valid.
  const withBadUsage = completeJobBodySchema.parse({
    output: { answer: "a" },
    executor: "w-1",
    usage: { inputTokens: -5, outputTokens: 1.5 }
  });
  assert.equal(withBadUsage.usage, undefined);
  assert.deepEqual(withBadUsage.output, { answer: "a" });

  const withGoodUsage = completeJobBodySchema.parse({
    output: { answer: "a" },
    usage: { inputTokens: 10, outputTokens: 2 }
  });
  assert.deepEqual(withGoodUsage.usage, { inputTokens: 10, outputTokens: 2 });
});

test("completeJob persists watcher-reported usage on the completion envelope (#241)", async () => {
  const ctx = makeTestContext();
  const withUsage = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);
  const output = { answer: "a", confidence: "high", citations: [] };
  assert.equal(
    (await completeJob(ctx, withUsage.id, output, "w-1", { inputTokens: 140, outputTokens: 25, totalTokens: 165 })).ok,
    true
  );
  const persisted = await ctx.jobs.get(withUsage.id);
  assert.deepEqual(persisted?.output, {
    result: output,
    executor: "w-1",
    usage: { inputTokens: 140, outputTokens: 25, totalTokens: 165 }
  });

  // No reported usage → no usage key at all, so the Insights rollup's
  // jsonb_typeof(output->'usage') = 'object' predicate cleanly skips the row.
  const withoutUsage = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);
  assert.equal((await completeJob(ctx, withoutUsage.id, output, "w-1")).ok, true);
  assert.deepEqual((await ctx.jobs.get(withoutUsage.id))?.output, { result: output, executor: "w-1" });
});

test("a malformed identity field is dropped by the body schema, never failing the completion", async () => {
  // provider/model are best-effort telemetry like usage: a non-string or blank
  // value must not 400 the whole complete POST. .catch(undefined) drops it.
  const withBadIdentity = completeJobBodySchema.parse({
    output: { answer: "a" },
    provider: 42,
    model: "   "
  });
  assert.equal(withBadIdentity.provider, undefined);
  assert.equal(withBadIdentity.model, undefined);
  assert.deepEqual(withBadIdentity.output, { answer: "a" });

  const withGoodIdentity = completeJobBodySchema.parse({
    output: { answer: "a" },
    provider: "openai-compatible",
    model: "gpt-test"
  });
  assert.equal(withGoodIdentity.provider, "openai-compatible");
  assert.equal(withGoodIdentity.model, "gpt-test");
});

test("completeJob persists the watcher-reported provider + model on the completion envelope", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);
  const output = { answer: "a", confidence: "high", citations: [] };
  assert.equal(
    (
      await completeJob(
        ctx,
        job.id,
        output,
        "w-1",
        { inputTokens: 10, outputTokens: 2 },
        { provider: "openai-compatible", model: "gpt-test" }
      )
    ).ok,
    true
  );
  assert.deepEqual((await ctx.jobs.get(job.id))?.output, {
    result: output,
    executor: "w-1",
    usage: { inputTokens: 10, outputTokens: 2 },
    provider: "openai-compatible",
    model: "gpt-test"
  });

  // A usage-less CLI completion still records WHICH provider/model ran, so the
  // spend shows as unmetered-on-that-model rather than invisible. No identity
  // at all (older watcher, non-AI job) → no keys on the envelope.
  const cliJob = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);
  assert.equal((await completeJob(ctx, cliJob.id, output, "w-1", undefined, { provider: "claude" })).ok, true);
  assert.deepEqual((await ctx.jobs.get(cliJob.id))?.output, { result: output, executor: "w-1", provider: "claude" });
});

test("a watcher drops out of the registry once silent past the active window", async () => {
  const ctx = makeTestContext();
  await claimJob(ctx, "w-stale", ["codex"]);
  // Let real time pass, then list with a 1ms window: the watcher is now stale.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await ctx.stores.watchers.list(1), []);
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

test("accepted failures stop surfacing as unacknowledged and retry clears acceptance", async () => {
  const ctx = makeTestContext();
  const created = await ctx.jobs.create("answer_question", answerInput());
  await assert.rejects(() => acceptFailedJob(ctx, created.id), /only failed/i);

  await claimJob(ctx, "worker", ["codex"]);
  for (let attempt = 0; attempt <= created.retryLimit; attempt += 1) {
    await failJob(ctx, created.id, { code: "provider", message: "failed", category: "provider" });
  }

  const accepted = await acceptFailedJob(ctx, created.id);
  assert.ok(accepted.acceptedAt);
  assert.equal((await getJob(ctx, created.id))?.acceptedAt, accepted.acceptedAt);
  assert.equal((await listJobs(ctx)).jobs[0].acceptedAt, accepted.acceptedAt);

  await retryJob(ctx, created.id);
  assert.equal((await getJob(ctx, created.id))?.acceptedAt, undefined);
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

test("waitForJob ends the wait as non-terminal when the caller's signal is aborted (#195)", async () => {
  const ctx = makeTestContext();
  const created = await ctx.jobs.create("answer_question", answerInput());
  // A long timeout that would otherwise keep polling; the aborted signal is what
  // ends the wait, standing in for a verify-closure POST the watcher gave up on.
  const result = await waitForJob(ctx, created.id, { timeoutMs: 10_000, pollMs: 1, signal: AbortSignal.abort() });
  assert.equal(result.terminal, false, "an aborted wait returns non-terminal, like a deadline timeout");
  assert.equal(result.job.state, "created");
});

test("runJobToCompletion cancels the orphaned job when the caller's signal is aborted (#195)", async () => {
  const ctx = makeTestContext();
  // Nothing claims the job; the aborted signal (not the deadline) ends the wait,
  // and the orphaned job is cancelled so no late watcher runs it unread.
  const result = await runJobToCompletion(ctx, "answer_question", answerInput(), { signal: AbortSignal.abort() });
  assert.equal(result.state, "cancelled");
  assert.equal((await getJob(ctx, result.id))?.state, "cancelled");
});

test("runJobToCompletion cancels a still-queued job once the bounded wait times out (#162)", async () => {
  const ctx = makeTestContext();
  // makeTestContext sets JOB_RUN_TO_COMPLETION_TIMEOUT_MS=100 / JOB_WAIT_POLL_MS=5,
  // and nothing ever claims this job, so the wait must give up and the orphaned
  // job must be cancelled rather than left queued for a late watcher to run.
  const result = await runJobToCompletion(ctx, "answer_question", answerInput());
  assert.equal(result.state, "cancelled");
  assert.equal((await getJob(ctx, result.id))?.state, "cancelled");
});

test("runJobToCompletion cancels a job a watcher already claimed once the bounded wait times out (#162)", async () => {
  const ctx = makeTestContext();
  const preexisting = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);
  assert.equal((await getJob(ctx, preexisting.id))?.state, "active");

  // reuseKey pins runJobToCompletion onto the pre-claimed job so the test can
  // observe a watcher mid-flight past the deadline, exactly the "late watcher"
  // scenario #162 describes: cancelling an active job cannot stop the watcher,
  // but it does mean the eventual completeJob() call is rejected (job_cancelled)
  // instead of quietly applying an unread result.
  const result = await runJobToCompletion(ctx, "answer_question", answerInput(), { reuseKey: () => "shared" });
  assert.equal(result.id, preexisting.id);
  assert.equal(result.state, "cancelled");
  assert.equal((await getJob(ctx, preexisting.id))?.state, "cancelled");

  const output: AnswerQuestionJobOutput = { answer: "too late", confidence: "high", citations: [] };
  assert.deepEqual(await completeJob(ctx, preexisting.id, output, "worker"), { ok: false, code: "job_cancelled" });
});

test("runJobToCompletion's timeout-cancel is race-safe against a job completing first (#162)", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);
  const output: AnswerQuestionJobOutput = { answer: "just in time", confidence: "high", citations: [] };

  // Simulate the exact race the timeout-cancel path has to survive: the watcher's
  // completeJob call lands in the instant between the bounded wait giving up and
  // the cancel actually reaching the broker.
  const realCancel = ctx.jobs.cancel.bind(ctx.jobs);
  ctx.jobs.cancel = async (id: string) => {
    await completeJob(ctx, id, output, "worker");
    return realCancel(id);
  };

  const result = await runJobToCompletion(ctx, "answer_question", answerInput(), { reuseKey: () => "shared" });
  assert.equal(result.id, job.id);
  assert.equal(result.state, "completed");
});

// reuseKey only matches jobs still in flight (created/retry/active/blocked), not
// completed ones — an already-completed job isn't "in flight" work to wait on,
// it is a finished result, which is a different (and out of scope) kind of
// caching. This test reuses a job that is still active when runJobToCompletion
// starts waiting on it, and only completes concurrently with that wait.
test("runJobToCompletion reuses a matching in-flight job instead of enqueueing a duplicate (#162)", async () => {
  const ctx = makeTestContext();
  const preexisting = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);

  const resultPromise = runJobToCompletion(ctx, "answer_question", answerInput(), { reuseKey: () => "shared" });
  const output: AnswerQuestionJobOutput = { answer: "already done", confidence: "high", citations: [] };
  await completeJob(ctx, preexisting.id, output, "worker");

  const result = await resultPromise;
  assert.equal(result.id, preexisting.id);
  assert.equal(result.state, "completed");

  // No second job was enqueued for this reuseKey.
  assert.equal((await listJobs(ctx, { type: "answer_question" })).total, 1);
});

test("runJobToCompletion creates a new job when no in-flight job matches reuseKey", async () => {
  const ctx = makeTestContext();
  await ctx.jobs.create("answer_question", answerInput("codex"));

  await runJobToCompletion(ctx, "answer_question", answerInput("openai-compatible"), {
    reuseKey: (input) => JSON.stringify(input)
  });

  // The two requests hash to different reuseKeys (different provider), so the
  // second call must not reuse the first job — it enqueues its own.
  assert.equal((await listJobs(ctx, { type: "answer_question" })).total, 2);
});

test("runJobToCompletion with an admission budget sheds a new create → throws, enqueues nothing (#288b)", async () => {
  const ctx = makeTestContext();
  // A per-tick budget of 0 sheds the very first create with budget_exhausted.
  ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick = 0;
  const budget = createFanoutBudget(ctx, "process_gaps_to_pull_requests", undefined);

  await assert.rejects(
    () =>
      runJobToCompletion(ctx, "reconcile_gap_clusters", { clusters: [], provider: "codex" }, { admission: { budget } }),
    (error: unknown) => {
      assert.ok(error instanceof MaintenanceShedError);
      assert.equal(error.reason, "budget_exhausted");
      assert.equal(error.jobType, "reconcile_gap_clusters");
      return true;
    }
  );
  // Nothing was enqueued — a shed is a pure no-op on the queue.
  assert.equal((await listJobs(ctx, { type: "reconcile_gap_clusters" })).total, 0);
  assert.equal(budget.snapshot().enqueued, 0);
  assert.equal(budget.snapshot().deferredByBudget, 1);
});

test("runJobToCompletion admission runs only on create — a reuseKey hit spends no budget (#288b)", async () => {
  const ctx = makeTestContext();
  // Budget 0 would shed any create; the reuse path must never consult it.
  ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick = 0;
  const budget = createFanoutBudget(ctx, "process_gaps_to_pull_requests", undefined);

  const preexisting = await ctx.jobs.create("reconcile_gap_clusters", { clusters: [], provider: "codex" });
  await claimJob(ctx, "worker", ["codex"]); // in-flight (active), so it is reusable

  // reuseKey matches the in-flight job, so runJobToCompletion waits on it instead
  // of creating — admission is bypassed entirely. The job never completes, so the
  // bounded wait times out and the orphan is cancelled (existing #162 behaviour).
  const result = await runJobToCompletion(
    ctx,
    "reconcile_gap_clusters",
    { clusters: [], provider: "codex" },
    { reuseKey: () => "shared", admission: { budget } }
  );

  assert.equal(result.id, preexisting.id);
  // No budget/capacity was spent, and no second job was enqueued.
  assert.equal(budget.snapshot().attempted, 0);
  assert.equal(budget.snapshot().enqueued, 0);
  assert.equal((await listJobs(ctx, { type: "reconcile_gap_clusters" })).total, 1);
});

test("display projection recursively redacts secrets without mutating stored input", () => {
  const input = { apiKey: "a", nested: [{ token: "b", authorization: "c" }], password: "d", safe: "ok" };
  const job: JobView = {
    id: "job",
    type: "refresh_flow_snapshot",
    queueName: "refresh_flow_snapshot",
    deadLetter: false,
    state: "created",
    input,
    retryCount: 0,
    retryLimit: 1,
    expireInSeconds: 60,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const projected = projectJob(job);
  assert.deepEqual(projected.input, {
    apiKey: "[redacted]",
    nested: [{ token: "[redacted]", authorization: "[redacted]" }],
    password: "[redacted]",
    safe: "ok"
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
    sources: [],
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

test("#161: a transient side-effect failure returns side_effects_failed, and the retried completion replays only the side effects", async () => {
  const ctx = makeTestContext();

  const validInput: DraftMarkdownProposalJobInput & { provider: "codex" } = {
    provider: "codex",
    gapSummaries: ["How to configure X"],
    triggeringQuestions: ["How do I configure X?"],
    evidence: [],
    sources: [],
    expectedOutput: "markdown_proposal"
  };
  const job = await ctx.jobs.create("draft_markdown_proposal", validInput);

  const output: DraftMarkdownProposalJobOutput = {
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r"
  };

  // Simulate a transient side-effect failure (e.g. a DB blip while drafting the
  // proposal) by making the store throw on the first attempt only.
  const originalCreate = ctx.stores.proposals.create.bind(ctx.stores.proposals);
  let createCalls = 0;
  ctx.stores.proposals.create = async (input) => {
    createCalls += 1;
    if (createCalls === 1) throw new Error("transient db error");
    return originalCreate(input);
  };

  // First attempt: the side effect fails, so the outcome is side_effects_failed
  // (the route maps this to a 500 the watcher's complete() retry loop re-POSTs on).
  const first = await completeJob(ctx, job.id, output, "w-1");
  assert.deepEqual(first, { ok: false, code: "side_effects_failed" });

  // The job itself must already be in its terminal "completed" state — pg-boss
  // will never redo the (paid-for) generation regardless of the side-effect
  // failure above, and the retry budget must be untouched.
  const afterFailure = await getJob(ctx, job.id);
  assert.equal(afterFailure?.state, "completed");
  assert.equal(afterFailure?.retryCount, 0);
  assert.equal((await ctx.stores.proposals.list(50)).length, 0, "no proposal was drafted yet");

  // Second attempt — exactly what the watcher's retry loop does (same POST):
  // the replay branch re-runs only the side effects from the persisted output,
  // and this time the store works.
  const retried = await completeJob(ctx, job.id, output, "w-1");
  assert.equal(retried.ok, true);

  const proposals = await ctx.stores.proposals.list(50);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].jobId, job.id);
  assert.equal(proposals[0].title, "Configure X");

  // A replay also works with no output body at all (an operator re-driving the
  // side effects manually) — the persisted { result } envelope is reused.
  const manualReplay = await completeJob(ctx, job.id, undefined, "w-1");
  assert.equal(manualReplay.ok, true);
  assert.equal((await ctx.stores.proposals.list(50)).length, 1, "replay is idempotent");
});

test("#161: failing a completed job (the watcher's exhausted-retry fallback) is a no-op that preserves the output", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "w-1", ["codex"]);
  const output = { answer: "a", confidence: "high" as const, citations: [] };
  assert.equal((await completeJob(ctx, job.id, output, "w-1")).ok, true);

  // If the watcher exhausts its complete() retries on side_effects_failed it
  // falls back to api.fail(runner_failed). pg-boss no-ops a fail on a row that
  // already reached `completed` (state < 'completed' guard), so the job — and
  // its persisted, paid-for output — must survive untouched.
  const failed = await failJob(ctx, job.id, {
    code: "runner_failed",
    message: "complete retries exhausted",
    category: "internal"
  });
  assert.equal(failed?.state, "completed");
  const after = await getJob(ctx, job.id);
  assert.equal(after?.state, "completed");
  assert.equal(after?.retryCount, 0);
  assert.deepEqual((after?.output as { result?: unknown } | undefined)?.result, output);
});

test("dedupe_documents completion drafts a file-set proposal and gates it (open-new → publish)", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("dedupe_documents", {
    path: "kb/refunds.md",
    content: "# Refunds",
    neighbours: [{ path: "kb/partial-refunds.md", content: "# Partial refunds" }],
    destinationId: "docs",
    flowId: "billing",
    provider: "codex"
  });
  const output = {
    duplicate: true,
    rationale: "merged the duplicate",
    primaryPath: "kb/refunds.md",
    changeset: [
      { path: "kb/refunds.md", content: "# Refunds\nincludes partial refunds" },
      { path: "kb/partial-refunds.md", delete: true }
    ]
  };

  assert.equal((await completeJob(ctx, job.id, output)).ok, true);

  const proposal = (await ctx.stores.proposals.list(50)).find((p) => p.jobId === job.id);
  assert.ok(proposal, "a dedupe proposal was drafted");
  assert.deepEqual(proposal?.changeset, output.changeset);
  // No same-flow overlap → the clusterless dedupe proposal self-publishes.
  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.deepEqual(
    actions.map((a) => a.proposalId),
    [proposal?.id]
  );
});

test("split_document completion drafts a file-set proposal and gates it (open-new -> publish)", async () => {
  const ctx = makeTestContext();
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: "docs",
    documents: [{ path: "kb/operations.md", content: "# Operations" }]
  });
  const job = await ctx.jobs.create("split_document", {
    path: "kb/operations.md",
    content: "# Operations",
    neighbours: [],
    destinationId: "docs",
    flowId: "billing",
    provider: "codex"
  });
  const output = {
    split: true,
    rationale: "moved billing detail out",
    primaryPath: "kb/operations.md",
    changeset: [
      { path: "kb/operations.md", content: "# Operations\nSee billing." },
      { path: "kb/billing-guide.md", content: "# Billing Guide" }
    ]
  };

  assert.equal((await completeJob(ctx, job.id, output)).ok, true);

  const proposal = (await ctx.stores.proposals.list(50)).find((p) => p.jobId === job.id);
  assert.ok(proposal, "a split proposal was drafted");
  assert.deepEqual(proposal?.changeset, output.changeset);
  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.deepEqual(
    actions.map((a) => a.proposalId),
    [proposal?.id]
  );
});

test("improve_document completion drafts a proposal and gates it (open-new -> publish)", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("improve_document", {
    path: "kb/refunds.md",
    content: "# Refunds",
    sources: [],
    destinationId: "docs",
    flowId: "billing",
    provider: "codex"
  });

  assert.equal(
    (
      await completeJob(ctx, job.id, {
        improved: true,
        markdown: "# Refunds\nPartial refunds are supported.",
        rationale: "Added source-backed coverage."
      })
    ).ok,
    true
  );

  const proposal = (await ctx.stores.proposals.list(50)).find((p) => p.jobId === job.id);
  assert.ok(proposal, "an improve proposal was drafted");
  assert.equal(proposal?.flowId, "billing");
  assert.ok(proposal?.title.startsWith("Improve:"));
  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.deepEqual(
    actions.map((a) => a.proposalId),
    [proposal?.id]
  );
});

test("improve_document no-op completion creates no proposal or publication action", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("improve_document", {
    path: "kb/refunds.md",
    content: "# Refunds",
    sources: [],
    destinationId: "docs",
    flowId: "billing",
    provider: "codex"
  });

  assert.equal((await completeJob(ctx, job.id, { improved: false, rationale: "Already complete." })).ok, true);
  assert.deepEqual(await ctx.stores.proposals.list(50), []);
  assert.deepEqual(await ctx.stores.gapClusters.listPendingPublicationActions(), []);
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

test("publish_proposal completion refreshes publication metadata on republish", async () => {
  const ctx = makeTestContext();

  const proposal = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.recordPublication(proposal.id, {
    provider: "local-git",
    branchName: "magpie/proposal-abc-configure-x",
    commitSha: "oldcommit",
    remoteUrl: "https://github.com/o/r.git",
    pullRequestUrl: "https://github.com/o/r/pull/9",
    publishedAt: "2026-01-01T00:00:00.000Z"
  });

  const job = await ctx.jobs.create("publish_proposal", { proposalId: proposal.id });
  const output = {
    proposalId: proposal.id,
    branchName: "magpie/proposal-abc-configure-x",
    commitSha: "newcommit",
    remoteUrl: "https://github.com/o/r.git",
    pullRequestUrl: "https://github.com/o/r/pull/9",
    publishedAt: "2026-01-02T00:00:00.000Z"
  };

  assert.equal((await completeJob(ctx, job.id, output)).ok, true);

  const republished = await ctx.stores.proposals.get(proposal.id);
  assert.equal(republished?.status, "pr-opened");
  assert.equal(republished?.publication?.commitSha, output.commitSha);
  assert.equal(republished?.publication?.publishedAt, output.publishedAt);
});

test("refresh_flow_snapshot completion applies merged/closed transitions idempotently", async () => {
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

  const job = await ctx.jobs.create("refresh_flow_snapshot", {});
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
  const job2 = await ctx.jobs.create("refresh_flow_snapshot", {});
  assert.equal((await completeJob(ctx, job2.id, output)).ok, true);
  assert.equal((await ctx.stores.proposals.get(mergedProposal.id))?.status, "merged");
  assert.equal((await ctx.stores.proposals.get(closedProposal.id))?.status, "rejected");
  assert.equal(resolveCalls, cascadesAfterFirst, "merge cascade must not run a second time");
});

test("refresh_flow_snapshot completion tolerates snapshot recording failures", async () => {
  const ctx = makeTestContext();
  ctx.stores.snapshots.write = async () => {
    throw new Error("snapshot root is not writable");
  };

  const job = await ctx.jobs.create("refresh_flow_snapshot", {});

  assert.equal((await completeJob(ctx, job.id, { results: [] })).ok, true);
  assert.equal((await ctx.jobs.get(job.id))?.state, "completed");
});

test("answer completion is idempotent when delivered twice", async () => {
  const ctx = makeTestContext();

  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
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
        excerpt: "Set the X flag.",
        relevance: 0.9
      }
    ],
    trace: {
      routing: { mode: "routed", flowId: "support", confidence: "high" },
      seedSectionCount: 1,
      searches: [{ query: "SOC 2", resultCount: 0, round: 1 }],
      poolSectionCount: 1,
      answerForced: false,
      answerContract: "structured",
      verification: { status: "grounded" }
    }
  };

  assert.equal((await completeJob(ctx, job.id, output)).ok, true);

  const updated = await ctx.stores.questionLogs.get(log.id);
  assert.ok(updated);
  assert.equal(updated.flowId, "support");
  assert.deepEqual(updated.retrievedSectionIds, ["support-kb:configure.md:0"]);
  // Guards the whole trace pipeline: completion validation must not strip the
  // trace (zod drops undeclared keys), and the store must persist it verbatim.
  assert.deepEqual(updated.answer?.trace, output.trace);
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
  // answer_question is repairable (#288d): a first schema-invalid output is routed
  // to one informed repair (repair_enqueued) with the SAME job moved to retry.
  const invalidResult = await completeJob(ctx, invalid.id, { answer: "missing contract fields" });
  assert.deepEqual(invalidResult, { ok: false, code: "repair_enqueued" });
  assert.equal((await getJob(ctx, invalid.id))?.state, "retry");

  const cancelled = await ctx.jobs.create("answer_question", answerInput());
  await cancelJob(ctx, cancelled.id);
  const cancelledResult = await completeJob(ctx, cancelled.id, {
    answer: "no",
    confidence: "high",
    citations: []
  });
  assert.deepEqual(cancelledResult, { ok: false, code: "job_cancelled" });
});

test("refresh_flow_snapshot completion persists a reported review decision", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "Refunds",
    targetPath: "kb/refunds.md",
    markdown: "# r",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.recordPublication(proposal.id, {
    provider: "local-git",
    branchName: "b",
    commitSha: "c",
    pullRequestUrl: "https://github.com/o/r/pull/3",
    publishedAt: new Date().toISOString()
  });

  const job = await ctx.jobs.create("refresh_flow_snapshot", {});
  assert.equal(
    (
      await completeJob(ctx, job.id, {
        results: [
          { proposalId: proposal.id, state: "open" as const, merged: false, reviewDecision: "approved" as const }
        ]
      })
    ).ok,
    true
  );
  assert.equal((await ctx.stores.proposals.get(proposal.id))?.reviewDecision, "approved");
});

test("refresh_flow_snapshot completion without a reviewDecision leaves a prior one intact", async () => {
  const ctx = makeTestContext();
  const proposal = await ctx.stores.proposals.create({
    title: "Credits",
    targetPath: "kb/credits.md",
    markdown: "# c",
    rationale: "r",
    evidence: []
  });
  await ctx.stores.proposals.recordPublication(proposal.id, {
    provider: "local-git",
    branchName: "b",
    commitSha: "c",
    pullRequestUrl: "https://github.com/o/r/pull/4",
    publishedAt: new Date().toISOString()
  });
  await ctx.stores.proposals.updateReviewDecision(proposal.id, "approved");

  // A later poll that could not determine the decision (no reviewDecision on the
  // result) must not clobber the stored approval back to touchable.
  const job = await ctx.jobs.create("refresh_flow_snapshot", {});
  assert.equal(
    (
      await completeJob(ctx, job.id, {
        results: [{ proposalId: proposal.id, state: "open" as const, merged: false }]
      })
    ).ok,
    true
  );
  assert.equal((await ctx.stores.proposals.get(proposal.id))?.reviewDecision, "approved");
});

test("completeJob on a correct_document job creates a corrective proposal and enqueues its publication", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("correct_document", {
    path: "a.md",
    content: "# a",
    claims: [{ claim: "stale", reason: "x" }],
    sources: [],
    destinationId: "docs",
    flowId: "billing",
    provider: "codex"
  });
  const result = await completeJob(ctx, job.id, { markdown: "# a (fixed)", rationale: "fixed" });
  assert.equal(result.ok, true);

  const proposal = (await ctx.stores.proposals.list(50)).find((p) => p.targetPath === "a.md");
  assert.ok(proposal);
  assert.equal(proposal?.flowId, "billing");

  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.ok(actions.some((a) => a.proposalId === proposal?.id && a.kind === "publish"));
});

test("completeJob on a draft_seed_document job creates a seed proposal and enqueues its publication", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("draft_seed_document", {
    flowId: "billing",
    coverage: ["overview"],
    sources: [],
    provider: "codex"
  });
  const result = await completeJob(ctx, job.id, {
    title: "Billing",
    targetPath: "billing.md",
    markdown: "# Billing",
    rationale: "seed"
  });
  assert.equal(result.ok, true);

  const proposal = (await ctx.stores.proposals.list(50)).find((p) => p.flowId === "billing");
  assert.ok(proposal);
  assert.equal(proposal?.gapClusterId, undefined);

  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.ok(actions.some((a) => a.proposalId === proposal?.id && a.kind === "publish"));
});

// parseCompletedJobOutput (#184): API-side consumers of runJobToCompletion read
// JobView.output, which in production is the { result, executor } envelope
// completeJob persists — the raw shape only ever comes from test fakes.
test("parseCompletedJobOutput unwraps the production { result, executor } envelope", () => {
  const output = { answer: "a", confidence: "high", citations: [] };
  const parsed = parseCompletedJobOutput(answerQuestionOutputSchema, { result: output, executor: "watcher" });
  assert.deepEqual(parsed, output);
});

test("parseCompletedJobOutput falls back to the raw output shape", () => {
  const output = { answer: "a", confidence: "high", citations: [] };
  assert.deepEqual(parseCompletedJobOutput(answerQuestionOutputSchema, output), output);
});

test("parseCompletedJobOutput returns undefined when neither shape validates", () => {
  assert.equal(parseCompletedJobOutput(answerQuestionOutputSchema, { result: { nope: true } }), undefined);
  assert.equal(parseCompletedJobOutput(answerQuestionOutputSchema, { nope: true }), undefined);
  assert.equal(parseCompletedJobOutput(answerQuestionOutputSchema, undefined), undefined);
});

// ---------------------------------------------------------------------------
// #288d — terminal-fail backstop + repair-reprompt on schema-invalid output
// ---------------------------------------------------------------------------

const fullCitation = (sectionId: string) => ({
  documentId: "d",
  sectionId,
  path: "p",
  heading: "h",
  anchor: "a",
  excerpt: "e",
  relevance: 1
});

// The job_repair structured events captured from logger.info during a test.
function repairEvents(info: ReturnType<typeof mock.method>): Array<Record<string, unknown>> {
  return info.mock.calls
    .map((call) => call.arguments[0])
    .filter(
      (arg): arg is Record<string, unknown> =>
        typeof arg === "object" && arg !== null && (arg as { event?: unknown }).event === "job_repair"
    );
}

// A repairable answer_question that has already had its one repair enqueued: it is
// re-claimed (active, repair context attached) and ready for the repaired output.
async function enqueueAnswerRepair(
  ctx: AppContext,
  priorInvalidOutput: unknown,
  input: Record<string, unknown> = {}
): Promise<string> {
  const job = await ctx.jobs.create("answer_question", { ...answerInput(), ...input });
  await claimJob(ctx, "worker", ["codex"]);
  const first = await completeJob(ctx, job.id, priorInvalidOutput);
  assert.deepEqual(first, { ok: false, code: "repair_enqueued" });
  // Re-dispatch: the fake broker left the job in retry; re-claim to run the repair.
  await claimJob(ctx, "worker", ["codex"]);
  return job.id;
}

test("(i) schema-invalid output on a NON-repairable type terminal-fails and fires terminal side-effects", async () => {
  const ctx = makeTestContext();
  const rival = await ctx.stores.proposals.create({
    title: "Rival",
    targetPath: "kb/x.md",
    markdown: "# r",
    rationale: "r",
    evidence: []
  });
  const job = await ctx.jobs.create("fold_markdown_proposal", {
    provider: "codex" as const,
    survivorProposalId: "surv",
    rivalProposalId: rival.id,
    targetPath: "kb/x.md",
    survivorMarkdown: "# s",
    rivalMarkdown: "# r",
    rivalGapSummaries: [],
    rivalEvidence: [],
    expectedOutput: "folded_markdown" as const
  });
  await claimJob(ctx, "worker", ["codex"]);

  const result = await completeJob(ctx, job.id, { not: "a valid fold output" });
  assert.deepEqual(result, { ok: false, code: "invalid_output" });

  const failed = await getJob(ctx, job.id);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.retryCount, 0);
  // Terminal side-effect: the fold fallback enqueued the rival to publish.
  const actions = await ctx.stores.gapClusters.listPendingPublicationActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].proposalId, rival.id);
  // No repair context is ever written for a non-repairable type.
  assert.equal(await ctx.stores.jobRepairContexts.get(job.id), undefined);
});

test("(ii) schema-invalid output on a REPAIRABLE type persists context and enqueues one repair", async () => {
  const ctx = makeTestContext();
  const info = mock.method(logger, "info");
  const job = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);

  const invalidOutput = { answer: "partial", citations: [{ sectionId: "s1" }] };
  const result = await completeJob(ctx, job.id, invalidOutput);
  assert.deepEqual(result, { ok: false, code: "repair_enqueued" });

  assert.equal((await getJob(ctx, job.id))?.state, "retry");
  const context = await ctx.stores.jobRepairContexts.get(job.id);
  assert.ok(context);
  assert.equal(context!.targetType, "answer_question");
  assert.equal(context!.attempt, 1);
  assert.deepEqual(context!.priorOutput, invalidOutput);
  assert.ok(context!.issues.length > 0);

  const events = repairEvents(info);
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "enqueued");
  assert.equal(events[0].jobId, job.id);
});

test("(iii) a repaired run with valid output completes, fans out side-effects, and deletes the context", async () => {
  const ctx = makeTestContext();
  const log = await ctx.stores.questionLogs.record({
    question: "How?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  const jobId = await enqueueAnswerRepair(
    ctx,
    { answer: "partial", citations: [fullCitation("s1")] },
    {
      questionLogId: log.id
    }
  );

  const info = mock.method(logger, "info");
  const repaired = { answer: "fixed", confidence: "high" as const, citations: [fullCitation("s1")] };
  const result = await completeJob(ctx, jobId, repaired);
  assert.equal(result.ok, true);

  assert.equal((await getJob(ctx, jobId))?.state, "completed");
  // Context deleted (the one-repair counter is cleared).
  assert.equal(await ctx.stores.jobRepairContexts.get(jobId), undefined);
  // Side-effect fired: the answer was written to the question log.
  assert.equal((await ctx.stores.questionLogs.get(log.id))?.answer?.answer, "fixed");

  const events = repairEvents(info);
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "succeeded");
});

test("(iv) a repaired run that is still schema-invalid terminal-fails and deletes the context", async () => {
  const ctx = makeTestContext();
  const jobId = await enqueueAnswerRepair(ctx, { answer: "partial", citations: [{ sectionId: "s1" }] });

  const info = mock.method(logger, "info");
  const result = await completeJob(ctx, jobId, { still: "invalid" });
  assert.deepEqual(result, { ok: false, code: "invalid_output" });

  assert.equal((await getJob(ctx, jobId))?.state, "failed");
  assert.equal(await ctx.stores.jobRepairContexts.get(jobId), undefined);

  const events = repairEvents(info);
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "failed");
});

test("(v) an answer_question repair that adds a citation not in the prior output terminal-fails", async () => {
  const ctx = makeTestContext();
  // Prior citations: only s1.
  const jobId = await enqueueAnswerRepair(ctx, { answer: "a", citations: [{ sectionId: "s1" }] });

  // Repaired output is schema-valid but ADDS s2 — the citation subset guard fails.
  const repaired = { answer: "fixed", confidence: "high" as const, citations: [fullCitation("s2")] };
  const result = await completeJob(ctx, jobId, repaired);
  assert.deepEqual(result, { ok: false, code: "invalid_output" });
  assert.equal((await getJob(ctx, jobId))?.state, "failed");
  assert.equal(await ctx.stores.jobRepairContexts.get(jobId), undefined);
});

test("(vi) with repair disabled by config, a repairable invalid output terminal-fails immediately", async () => {
  const base = makeTestContext();
  const ctx: AppContext = {
    ...base,
    settings: { ...base.settings, jobs: { ...base.settings.jobs, repairEnabled: false } }
  };
  const job = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);

  const result = await completeJob(ctx, job.id, { answer: "partial", citations: [{ sectionId: "s1" }] });
  assert.deepEqual(result, { ok: false, code: "invalid_output" });
  assert.equal((await getJob(ctx, job.id))?.state, "failed");
  assert.equal(await ctx.stores.jobRepairContexts.get(job.id), undefined);
});

test("(c) answer_question_batch is repairable and enforces the citation-subset guard (#288c)", async () => {
  const ctx = makeTestContext();
  // A schema-invalid batch output must take the SAME one informed repair as
  // answer_question, not immediate terminal-fail (it shares the answer contract).
  const job = await ctx.jobs.create("answer_question_batch", answerInput());
  await claimJob(ctx, "worker", ["codex"]);
  const first = await completeJob(ctx, job.id, { answer: "a", citations: [{ sectionId: "s1" }] });
  assert.deepEqual(first, { ok: false, code: "repair_enqueued" });
  assert.equal((await getJob(ctx, job.id))?.state, "retry");
  const context = await ctx.stores.jobRepairContexts.get(job.id);
  assert.equal(context?.targetType, "answer_question_batch");

  // Re-dispatch the repair, then feed a schema-valid repaired output that ADDS a
  // citation absent from the prior output — the answer-contract citation guard
  // must reject it and terminal-fail, exactly as for answer_question.
  await claimJob(ctx, "worker", ["codex"]);
  const repaired = { answer: "fixed", confidence: "high" as const, citations: [fullCitation("s2")] };
  const result = await completeJob(ctx, job.id, repaired);
  assert.deepEqual(result, { ok: false, code: "invalid_output" });
  assert.equal((await getJob(ctx, job.id))?.state, "failed");
  assert.equal(await ctx.stores.jobRepairContexts.get(job.id), undefined);
});

test("(vii) an extra undeclared field succeeds, is stripped from the stored result, and warns", async () => {
  const ctx = makeTestContext();
  const warn = mock.method(logger, "warn");
  const job = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);

  const result = await completeJob(ctx, job.id, {
    answer: "ok",
    confidence: "high",
    citations: [],
    bogusField: { nested: 1 }
  });
  assert.equal(result.ok, true);

  const stored = await getJob(ctx, job.id);
  assert.ok(!JSON.stringify(stored?.output).includes("bogusField"), "undeclared field stripped from storage");
  assert.ok(JSON.stringify(stored?.output).includes('"answer"'), "declared fields survive");

  const stripWarnings = warn.mock.calls
    .map((call) => call.arguments[0])
    .filter(
      (arg): arg is Record<string, unknown> =>
        typeof arg === "object" && arg !== null && Array.isArray((arg as { strippedKeys?: unknown }).strippedKeys)
    );
  assert.equal(stripWarnings.length, 1);
  assert.deepEqual(stripWarnings[0].strippedKeys, ["bogusField"]);
});

test("(viii) failJob without terminal still retries; a first transient provider failure goes to retry", async () => {
  const ctx = makeTestContext();
  const job = await ctx.jobs.create("answer_question", answerInput());
  await claimJob(ctx, "worker", ["codex"]);

  const failed = await failJob(ctx, job.id, {
    code: "provider_error",
    message: "transient",
    category: "provider"
  });
  assert.equal(failed?.state, "retry");
});

test("strippedOutputKeyPaths reports object-level strips (nested) and treats arrays as leaves", () => {
  assert.deepEqual(strippedOutputKeyPaths({ a: 1, b: 2 }, { a: 1 }), ["b"]);
  assert.deepEqual(strippedOutputKeyPaths({ a: { x: 1, y: 2 } }, { a: { x: 1 } }), ["a.y"]);
  // Arrays are leaves: an element-level difference is not walked/reported.
  assert.deepEqual(strippedOutputKeyPaths({ a: [{ x: 1, y: 2 }] }, { a: [{ x: 1 }] }), []);
  assert.deepEqual(strippedOutputKeyPaths({ a: 1 }, { a: 1 }), []);
});
