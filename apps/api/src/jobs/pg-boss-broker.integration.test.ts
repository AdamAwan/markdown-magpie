import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobError, JobType } from "@magpie/jobs";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { PgBossJobBroker } from "./pg-boss-broker.js";

const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/markdown_magpie";
const schema = `pgboss_test_${process.pid}`;

// answer_question input matches the current catalog schema: routing candidate
// flows are required (the watcher routes over them); `context` was removed when
// retrieval moved into the watcher. An empty flows array is valid (the unscoped
// case the ask service emits when no flows are configured).
const codexAnswer = (question: string) => ({
  provider: "codex" as const,
  question,
  flows: [],
  expectedOutput: "answer_result" as const
});

const openAiAnswer = (question: string) => ({
  provider: "openai-compatible" as const,
  question,
  flows: [],
  expectedOutput: "answer_result" as const
});

const providerError: JobError = {
  code: "provider_error",
  message: "Provider failed",
  category: "provider"
};

test("pg-boss broker implements the durable job lifecycle", { skip: !runIntegration }, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const broker = new PgBossJobBroker({
    connectionString: databaseUrl,
    pool,
    schema,
    queuePolicyOverrides: {
      retryLimit: 1,
      retryDelay: 1,
      retryBackoff: false
    }
  });
  t.before(() => broker.start());
  t.beforeEach(() => broker.reset());
  t.after(async () => {
    await broker.reset();
    await broker.stop();
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });

  await t.test("creates and retrieves validated jobs", async () => {
    const created = await broker.create("answer_question", codexAnswer("created"));
    const found = await broker.get(created.id);
    assert.equal(found?.id, created.id);
    assert.equal(found?.state, "created");
    assert.equal(found?.queueName, "answer_question__codex");
    assert.deepEqual(found?.input, codexAnswer("created"));
  });

  await t.test("countInFlight counts in-flight AI jobs and ignores finished ones", async () => {
    assert.equal(await broker.countInFlight(["answer_question"]), 0);

    const first = await broker.create("answer_question", codexAnswer("count-1"));
    await broker.create("answer_question", openAiAnswer("count-2"));
    // Two created jobs across two provider queues are both in flight.
    assert.equal(await broker.countInFlight(["answer_question"]), 2);

    // A claimed (active) job still counts; a completed one does not.
    const claimed = await broker.claim("codex-worker", ["codex"]);
    assert.equal(claimed?.id, first.id);
    assert.equal(await broker.countInFlight(["answer_question"]), 2);
    await broker.complete(first.id, { answer: "done", confidence: "high", citations: [] });
    assert.equal(await broker.countInFlight(["answer_question"]), 1);

    // A different type's queue is not counted unless asked for.
    assert.equal(await broker.countInFlight(["draft_markdown_proposal"]), 0);
  });

  await t.test("countInFlight isolates answer_question from answer_question_batch (#288c)", async () => {
    // The whole point of the batch type: countInFlight tallies each job type by
    // its own queue name, so questionnaire batch jobs never inflate the live-ask
    // count and vice-versa. INTERACTIVE_AI_JOB_TYPES excludes the batch type, so
    // the interactive reserve never sees questionnaire load.
    assert.equal(await broker.countInFlight(["answer_question"]), 0);
    assert.equal(await broker.countInFlight(["answer_question_batch"]), 0);

    await broker.create("answer_question", codexAnswer("live-1"));
    await broker.create("answer_question_batch", codexAnswer("batch-1"));
    await broker.create("answer_question_batch", openAiAnswer("batch-2"));

    // Each type counts only its own jobs.
    assert.equal(await broker.countInFlight(["answer_question"]), 1, "batch jobs do not count as live asks");
    assert.equal(await broker.countInFlight(["answer_question_batch"]), 2, "live asks do not count as batch");

    // The interactive lane (answer_question + outline_flow_seed) excludes batch.
    assert.equal(
      await broker.countInFlight(["answer_question", "outline_flow_seed"]),
      1,
      "the interactive reserve never sees questionnaire batch load"
    );
    // Asked together, both are tallied — the global AI ceiling counts every class.
    assert.equal(await broker.countInFlight(["answer_question", "answer_question_batch"]), 3);
  });

  await t.test("isolates providers and claims same-queue jobs FIFO", async () => {
    const first = await broker.create("answer_question", codexAnswer("first"));
    const second = await broker.create("answer_question", codexAnswer("second"));
    const openAi = await broker.create("answer_question", openAiAnswer("hosted"));

    const codexClaim = await broker.claim("codex-worker", ["codex"]);
    assert.equal(codexClaim?.id, first.id);
    await broker.complete(codexClaim!.id, { answer: "one", confidence: "high", citations: [] });

    const secondClaim = await broker.claim("codex-worker", ["codex"]);
    assert.equal(secondClaim?.id, second.id);
    await broker.complete(secondClaim!.id, { answer: "two", confidence: "high", citations: [] });

    assert.equal(await broker.claim("codex-worker", ["codex"]), undefined);
    const openAiClaim = await broker.claim("openai-worker", ["openai-compatible"]);
    assert.equal(openAiClaim?.id, openAi.id);
    await broker.complete(openAiClaim!.id, { answer: "hosted", confidence: "high", citations: [] });
  });

  await t.test("claims interactive-class jobs ahead of earlier background work", async () => {
    // Background fan-out lands first, then a live ask arrives: the ask must be
    // claimed before both older jobs (#240's interactive lane), and only then
    // does the background backlog drain.
    const proposal = await broker.create("draft_markdown_proposal", {
      provider: "codex",
      gapSummaries: ["gap"],
      triggeringQuestions: ["question"],
      evidence: [],
      sources: [],
      expectedOutput: "markdown_proposal"
    });
    const summary = await broker.create("summarize_gap", {
      provider: "codex",
      questions: ["q"],
      citedSections: [],
      expectedOutput: "gap_summary"
    });
    const answer = await broker.create("answer_question", codexAnswer("live-ask"));

    const claimed = [];
    for (let index = 0; index < 3; index += 1) {
      const job = await broker.claim("multipurpose", ["codex"]);
      assert.ok(job);
      claimed.push(job);
    }
    assert.equal(claimed[0]!.id, answer.id);
    assert.deepEqual(new Set(claimed.slice(1).map((job) => job.id)), new Set([proposal.id, summary.id]));
    // Background queues keep the round-robin fairness the combined loop had:
    // the two background claims come from two different queues.
    assert.deepEqual(
      new Set(claimed.slice(1).map((job) => job.queueName)),
      new Set(["draft_markdown_proposal__codex", "summarize_gap__codex"])
    );
    for (const job of claimed) {
      await broker.cancel(job.id);
    }
  });

  await t.test("touches, retries failures, completes, cancels, and manually retries", async () => {
    const retrying = await broker.create("answer_question", codexAnswer("retry"));
    const active = await broker.claim("worker", ["codex"]);
    assert.equal(active?.id, retrying.id);
    const { job: heartbeat, active: stillHeld } = await broker.heartbeat(retrying.id);
    assert.equal(stillHeld, true);
    assert.equal(heartbeat.state, "active");
    assert.ok(heartbeat.heartbeatAt);

    const failedAttempt = await broker.fail(retrying.id, providerError);
    assert.equal(failedAttempt.state, "retry");
    assert.equal(failedAttempt.retryCount, 0);

    let claimedRetry;
    const deadline = Date.now() + 10_000;
    while (!claimedRetry && Date.now() < deadline) {
      claimedRetry = await broker.claim("worker", ["codex"]);
      if (!claimedRetry) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(claimedRetry?.id, retrying.id);
    assert.equal(claimedRetry?.retryCount, 1);
    const output = { answer: "recovered", confidence: "medium" as const, citations: [] };
    const completed = await broker.complete(retrying.id, output);
    assert.equal(completed.state, "completed");
    assert.deepEqual(completed.output, output);

    const cancelledJob = await broker.create("answer_question", codexAnswer("cancel"));
    assert.equal((await broker.cancel(cancelledJob.id)).state, "cancelled");

    const exhausted = await broker.create("refresh_flow_snapshot", {});
    let claimed = await broker.claim("github-worker", ["github"]);
    for (let attempt = 0; attempt <= exhausted.retryLimit; attempt += 1) {
      assert.equal(claimed?.id, exhausted.id);
      const failed = await broker.fail(exhausted.id, providerError);
      if (attempt < exhausted.retryLimit) {
        assert.equal(failed.state, "retry");
        claimed = undefined;
        const retryDeadline = Date.now() + 10_000;
        while (!claimed && Date.now() < retryDeadline) {
          claimed = await broker.claim("github-worker", ["github"]);
          if (!claimed) await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.equal(claimed?.id, exhausted.id);
      } else {
        assert.equal(failed.state, "failed");
      }
    }
    const retried = await broker.retry(exhausted.id);
    assert.ok(retried.state === "created" || retried.state === "retry");
    await broker.cancel(exhausted.id);
  });

  await t.test("failTerminal fails to terminal + dead-letter on the first invalid output (#288d)", async () => {
    // The backstop: a claimed (active) provider job that terminal-fails goes
    // straight to `failed` (retryCount unchanged) despite retries remaining, is
    // not re-claimable, and lands a dead-letter row.
    const job = await broker.create("answer_question", codexAnswer("terminal"));
    const claimed = await broker.claim("codex-worker", ["codex"]);
    assert.equal(claimed?.id, job.id);
    assert.equal(claimed?.retryCount, 0);

    const failed = await broker.failTerminal(job.id, providerError);
    assert.equal(failed.state, "failed");
    assert.equal(failed.retryCount, 0);

    // No retry was scheduled: the job is not re-claimable.
    assert.equal(await broker.claim("codex-worker", ["codex"]), undefined);

    // A dead-letter row exists for the partition's dead-letter queue.
    const dl = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM "${schema}".job WHERE name = $1`, [
      "answer_question__codex__dead_letter"
    ]);
    assert.ok((dl.rows[0]?.c ?? 0) >= 1, "a dead-letter row exists");

    // failTerminal on an already-completed job is a no-op (protects the replay
    // contract): the completed output and state survive untouched.
    const completed = await broker.create("answer_question", codexAnswer("completed"));
    await broker.claim("codex-worker", ["codex"]);
    const output = { result: { answer: "a" }, executor: "w" };
    await broker.complete(completed.id, output);
    const afterTerminal = await broker.failTerminal(completed.id, providerError);
    assert.equal(afterTerminal.state, "completed");
    assert.deepEqual(afterTerminal.output, output);
  });

  await t.test("filters lists and resets jobs", async () => {
    await broker.create("answer_question", codexAnswer("listed"));
    await broker.create("refresh_flow_snapshot", {});
    const listed = await broker.list({ type: "answer_question", state: "created", limit: 1, offset: 0 });
    assert.equal(listed.jobs.length, 1);
    assert.ok(listed.total >= 1);
    assert.equal(listed.jobs[0]?.type, "answer_question");
  });

  await t.test("reconciles schedules idempotently and removes stale schedules", async () => {
    const desired = [
      {
        type: "source_change_sync" as const,
        key: "task:source-change-sync::docs",
        cron: "*/5 * * * *",
        input: { flowId: "docs" },
        enabled: true
      }
    ];
    await broker.reconcileSchedules(desired);
    await broker.reconcileSchedules(desired);
    assert.deepEqual(
      (await broker.listSchedules()).map(({ key, type, cron, enabled }) => ({ key, type, cron, enabled })),
      [
        {
          key: "task:source-change-sync::docs",
          type: "source_change_sync",
          cron: "*/5 * * * *",
          enabled: true
        }
      ]
    );

    await broker.reconcileSchedules([]);
    assert.deepEqual(await broker.listSchedules(), []);
  });

  await broker.reset();
  assert.equal((await broker.list({})).total, 0);
});

// Listing and guard reads at a realistic queue size. pg-boss's public findJobs is
// capped at LIMIT 1000 ordered oldest-first, so a findJobs-based list() saw only
// the oldest 1000 rows of a busy queue (30-day retention keeps far more), and the
// in-flight guards built on it went blind. This pins the SQL-backed reads: with
// >1000 retained jobs in ONE queue, list() returns the true newest page with an
// exact total, state filters run over every row, the newest in-flight job is
// found by findMatchingJobs, and get() is a single by-id lookup.
test("pg-boss broker lists and matches correctly past 1000 jobs in one queue", { skip: !runIntegration }, async (t) => {
  const listSchema = `${schema}_list`;
  const pool = new Pool({ connectionString: databaseUrl });
  const broker = new PgBossJobBroker({ connectionString: databaseUrl, pool, schema: listSchema });
  const retained = 1100;
  const queue = "verify_gap_closure";

  t.before(async () => {
    await broker.start();
    await broker.reset();
    // Enqueue through the broker (real envelopes, real queue routing), in small
    // concurrent batches to keep setup quick.
    for (let start = 0; start < retained; start += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, retained - start) }, (_unused, offset) =>
          broker.create("verify_gap_closure", { proposalId: `p-${start + offset}` })
        )
      );
    }
    // Age that backlog into retained, finished history — the shape a month of
    // completed jobs leaves behind. Claiming/completing 1100 rows one at a time
    // would only slow the test down without exercising anything list() reads.
    await pool.query(
      `UPDATE "${listSchema}".job
          SET state = 'completed', started_on = created_on, completed_on = created_on,
              created_on = created_on - interval '1 hour'
        WHERE name = $1`,
      [queue]
    );
  });
  t.after(async () => {
    await broker.reset();
    await broker.stop();
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${listSchema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });

  await t.test("list() returns the newest jobs first with an exact total", async () => {
    const target = await broker.create("verify_gap_closure", { proposalId: "target" });

    const firstPage = await broker.list({ type: "verify_gap_closure", limit: 200 });
    assert.equal(firstPage.total, retained + 1);
    assert.equal(firstPage.jobs.length, 200);
    assert.equal(firstPage.jobs[0]?.id, target.id, "the job created last heads the page");
    const createdAts = firstPage.jobs.map((job) => job.createdAt);
    assert.deepEqual(createdAts, [...createdAts].sort().reverse(), "newest first");

    // OFFSET pages over the whole set, not a 1000-row prefix of it.
    const lastPage = await broker.list({ type: "verify_gap_closure", limit: 200, offset: 1000 });
    assert.equal(lastPage.total, retained + 1);
    assert.equal(lastPage.jobs.length, retained + 1 - 1000);

    // Untyped listing sees the same rows.
    assert.equal((await broker.list({ limit: 1 })).total, retained + 1);
  });

  await t.test("the state filter runs over every row, not a page", async () => {
    const completed = await broker.list({ type: "verify_gap_closure", state: "completed", limit: 200 });
    assert.equal(completed.total, retained);
    assert.equal(completed.jobs.length, 200);
    assert.ok(completed.jobs.every((job) => job.state === "completed"));

    const created = await broker.list({ type: "verify_gap_closure", state: "created" });
    assert.equal(created.total, 1);
    assert.deepEqual(
      created.jobs.map((job) => job.input),
      [{ proposalId: "target" }]
    );

    const recent = await broker.list({
      type: "verify_gap_closure",
      createdAfter: new Date(Date.now() - 10 * 60_000).toISOString()
    });
    assert.equal(recent.total, 1, "only the un-aged job is newer than ten minutes");
  });

  await t.test("findMatchingJobs finds the in-flight job created last behind the backlog", async () => {
    const [target] = (await broker.list({ type: "verify_gap_closure", state: "created" })).jobs;
    assert.ok(target);

    const inFlight = await broker.findMatchingJobs({ type: "verify_gap_closure", inFlight: true });
    assert.deepEqual(
      inFlight.map((job) => job.id),
      [target.id]
    );
    const byInput = await broker.findMatchingJobs({
      type: "verify_gap_closure",
      inFlight: true,
      input: { proposalId: "target" }
    });
    assert.deepEqual(
      byInput.map((job) => job.id),
      [target.id]
    );

    // A retained, finished job matches by input only when in-flight isn't asked for
    // — including one from the very oldest end of the backlog.
    assert.equal(
      (await broker.findMatchingJobs({ type: "verify_gap_closure", input: { proposalId: "p-0" } })).length,
      1
    );
    assert.deepEqual(
      await broker.findMatchingJobs({ type: "verify_gap_closure", inFlight: true, input: { proposalId: "p-0" } }),
      []
    );

    // A dead-lettered copy (created on the dead-letter queue) is finished work,
    // not a second in-flight job.
    const doomed = await broker.create("verify_gap_closure", { proposalId: "doomed" });
    await broker.failTerminal(doomed.id, providerError);
    assert.deepEqual(
      await broker.findMatchingJobs({ type: "verify_gap_closure", inFlight: true, input: { proposalId: "doomed" } }),
      []
    );
    assert.equal(
      (await broker.findMatchingJobs({ type: "verify_gap_closure", input: { proposalId: "doomed" } }))[0]?.state,
      "failed"
    );
  });

  await t.test("get() resolves a job by id in a single query, without probing queues", async () => {
    const target = await broker.create("verify_gap_closure", { proposalId: "lookup" });
    const query = t.mock.method(pool, "query");
    const found = await broker.get(target.id);
    assert.equal(query.mock.callCount(), 1, "one by-id query, not one per queue");
    query.mock.restore();
    assert.equal(found?.id, target.id);
    assert.equal(found?.queueName, queue);
    assert.equal(found?.state, "created");

    assert.equal(await broker.get("00000000-0000-4000-8000-000000000000"), undefined);
    assert.equal(await broker.get("not-a-uuid"), undefined);

    // The by-id lookup also backs the mutators.
    assert.equal((await broker.cancel(target.id)).state, "cancelled");
  });
});

// The atomic admission primitive (#288a). A separate schema keeps its own
// throwaway state; each sub-test resets first.
test("createIfAdmitted enforces the in-flight ceiling atomically", { skip: !runIntegration }, async (t) => {
  const admissionSchema = `${schema}_admit`;
  const pool = new Pool({ connectionString: databaseUrl });
  const broker = new PgBossJobBroker({ connectionString: databaseUrl, pool, schema: admissionSchema });
  // AI_JOB_TYPES / INTERACTIVE_AI_JOB_TYPES kept literal here so the reserve
  // semantics under test are pinned to the real job classes.
  const globalTypes: JobType[] = ["answer_question", "summarize_gap"];
  const interactiveTypes: JobType[] = ["answer_question"];

  t.before(() => broker.start());
  t.beforeEach(() => broker.reset());
  t.after(async () => {
    await broker.reset();
    await broker.stop();
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${admissionSchema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });

  await t.test("admits up to the limit, rejects beyond it, and creates no row when rejected", async () => {
    const capacity = { types: globalTypes, limit: 2 };

    const first = await broker.createIfAdmitted("answer_question", codexAnswer("a1"), capacity);
    const second = await broker.createIfAdmitted("answer_question", openAiAnswer("a2"), capacity);
    assert.equal(first.admitted, true);
    assert.equal(second.admitted, true);
    assert.equal(await broker.countInFlight(globalTypes), 2);

    const third = await broker.createIfAdmitted("answer_question", codexAnswer("a3"), capacity);
    assert.equal(third.admitted, false);
    assert.equal(third.job, undefined);
    assert.equal(third.inFlight, 2);
    // Rejection enqueued nothing — still exactly 2 in flight.
    assert.equal(await broker.countInFlight(globalTypes), 2);

    // Freeing a slot lets the next admission through. pg-boss (12.39+) only
    // completes an ACTIVE job (its attempt fence), so claim it first as a watcher
    // would — completing a still-queued job is a silent no-op.
    assert.equal((await broker.claim("codex-worker", ["codex"]))?.id, first.job!.id);
    await broker.complete(first.job!.id, { answer: "done", confidence: "high", citations: [] });
    const fourth = await broker.createIfAdmitted("answer_question", codexAnswer("a4"), capacity);
    assert.equal(fourth.admitted, true);
    assert.equal(await broker.countInFlight(globalTypes), 2);
  });

  await t.test("reserve lets interactive work in while the global lane is full, then rejects", async () => {
    const capacity = {
      types: globalTypes,
      limit: 2,
      reserve: { types: interactiveTypes, reserved: 1 }
    };

    // Two maintenance jobs fill the global ceiling but touch none of the reserve.
    await broker.create("summarize_gap", {
      provider: "codex",
      questions: ["q1"],
      citedSections: [],
      expectedOutput: "gap_summary"
    });
    await broker.create("summarize_gap", {
      provider: "codex",
      questions: ["q2"],
      citedSections: [],
      expectedOutput: "gap_summary"
    });
    assert.equal(await broker.countInFlight(globalTypes), 2);

    // An interactive ask still admits via the reserve (reserveInFlight 0 < 1).
    const viaReserve = await broker.createIfAdmitted("answer_question", codexAnswer("live"), capacity);
    assert.equal(viaReserve.admitted, true);
    assert.equal(viaReserve.reserveInFlight, 0);

    // Now the reserve is occupied and the global lane is over the ceiling: reject.
    const rejected = await broker.createIfAdmitted("answer_question", openAiAnswer("live2"), capacity);
    assert.equal(rejected.admitted, false);
    assert.equal(rejected.reserveInFlight, 1);
    assert.ok(rejected.inFlight >= 2);
  });

  await t.test("50 concurrent admissions at limit 10 admit exactly 10 — no overshoot", async () => {
    const capacity = { types: globalTypes, limit: 10 };
    const attempts = Array.from({ length: 50 }, (_unused, index) =>
      broker.createIfAdmitted("answer_question", codexAnswer(`race-${index}`), capacity)
    );
    const results = await Promise.all(attempts);
    const admitted = results.filter((result) => result.admitted).length;
    assert.equal(admitted, 10, "exactly the ceiling admitted");
    assert.equal(await broker.countInFlight(globalTypes), 10, "no overshoot in the durable count");
  });
});

// docs/ai-jobs.md J60–J66 and docs/rate-limiting.md RL29, against real pg-boss:
// the attempt fence, the lapsed-retry salvage, the mapping of pg-boss's own
// failures, the settlement ledger (migration 0075 must be applied to
// DATABASE_URL), the live-watcher capacity count, and scheduled-tick retention.
test("pg-boss broker fences, salvages and settles lost work", { skip: !runIntegration }, async (t) => {
  const lifecycleSchema = `${schema}_life`;
  const pool = new Pool({ connectionString: databaseUrl });
  const broker = new PgBossJobBroker({
    connectionString: databaseUrl,
    pool,
    schema: lifecycleSchema,
    queuePolicyOverrides: { retryLimit: 2, retryDelay: 1, retryBackoff: false }
  });
  // A second pg-boss handle on the same schema, only to run pg-boss's own
  // supervision on demand (the broker's runs on its own timer).
  const supervisor = new PgBoss({
    connectionString: databaseUrl,
    schema: lifecycleSchema,
    supervise: false,
    schedule: false
  });
  t.before(async () => {
    await broker.start();
    await supervisor.start();
  });
  t.beforeEach(() => broker.reset());
  t.after(async () => {
    await broker.reset();
    await supervisor.stop();
    await broker.stop();
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${lifecycleSchema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });

  async function claimEventually(capability: "codex" | "github") {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const claimed = await broker.claim("w", [capability]);
      if (claimed || Date.now() > deadline) return claimed;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const answer = { answer: "a", confidence: "high" as const, citations: [] };

  await t.test("J60: a lapsed attempt cannot heartbeat, complete or fail the attempt that replaced it", async () => {
    const job = await broker.create("answer_question", codexAnswer("fence"));
    const first = await claimEventually("codex");
    assert.equal(first?.retryCount, 0);
    await broker.fail(job.id, providerError); // the claim lapses back to retry
    const second = await claimEventually("codex");
    assert.equal(second?.retryCount, 1);

    assert.equal((await broker.heartbeat(job.id, { attempt: 0 })).active, false);
    assert.equal((await broker.heartbeat(job.id, { attempt: 1 })).active, true);
    assert.equal((await broker.complete(job.id, { result: answer }, { attempt: 0 })).state, "active");
    assert.equal((await broker.fail(job.id, providerError, { attempt: 0 })).state, "active");
    const afterStaleTerminal = await broker.failTerminal(job.id, providerError, { attempt: 0 });
    assert.equal(afterStaleTerminal.state, "active");
    assert.equal(afterStaleTerminal.retryLimit, 2, "a stale terminal fail must not zero the live attempt's budget");

    assert.equal((await broker.complete(job.id, { result: answer }, { attempt: 1 })).state, "completed");
    assert.equal((await broker.heartbeat(job.id, { attempt: 1 })).active, false, "a completed job is no longer held");
  });

  await t.test("J61: a lapsed attempt's completion is salvaged from its own un-reclaimed retry", async () => {
    const job = await broker.create("answer_question", codexAnswer("salvage"));
    await claimEventually("codex");
    await broker.fail(job.id, providerError);
    const salvaged = await broker.complete(job.id, { result: answer }, { attempt: 0 });
    assert.equal(salvaged.state, "completed");
    assert.deepEqual(salvaged.output, { result: answer });
  });

  await t.test("J63: a job pg-boss fails by itself carries a structured error and is listed unsettled", async () => {
    const job = await broker.create("answer_question", codexAnswer("heartbeat-lost"));
    await claimEventually("codex");
    // Simulate a watcher that stopped heartbeating on its last attempt.
    await pool.query(
      `UPDATE "${lifecycleSchema}".job SET heartbeat_on = now() - interval '1 hour', retry_limit = 0 WHERE id = $1`,
      [job.id]
    );
    // pg-boss throttles its monitor pass per queue; clear the last claim so the
    // on-demand pass below runs now rather than after monitorIntervalSeconds.
    await pool.query(
      `UPDATE "${lifecycleSchema}".queue SET monitor_claim_on = NULL, monitor_on = NULL WHERE name = $1`,
      ["answer_question__codex"]
    );
    await supervisor.supervise("answer_question__codex");
    const failed = await broker.get(job.id);
    assert.equal(failed?.state, "failed");
    assert.deepEqual(failed?.error, {
      code: "job_heartbeat_lost",
      message: "job heartbeat timeout",
      category: "timeout"
    });
    const unsettled = await broker.listUnsettledFailures(50);
    assert.ok(unsettled.some((candidate) => candidate.id === job.id));
  });

  await t.test("J64: concurrent settlements of one failure run its side effects exactly once", async () => {
    const job = await broker.create("refresh_flow_snapshot", {});
    await claimEventually("github");
    const failed = await broker.failTerminal(job.id, providerError);
    let runs = 0;
    const settle = () =>
      broker.settleFailure(failed, async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    const results = await Promise.all([settle(), settle(), settle()]);
    assert.equal(runs, 1);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await settle(), false, "a settled failure never runs again");
    assert.ok(!(await broker.listUnsettledFailures(50)).some((candidate) => candidate.id === job.id));

    // A run that throws releases the claim: the failure stays unsettled.
    const other = await broker.create("refresh_flow_snapshot", {});
    await claimEventually("github");
    const otherFailed = await broker.failTerminal(other.id, providerError);
    await assert.rejects(
      broker.settleFailure(otherFailed, async () => {
        throw new Error("store down");
      }),
      /store down/
    );
    assert.ok((await broker.listUnsettledFailures(50)).some((candidate) => candidate.id === other.id));
    assert.equal(await broker.settleFailure(otherFailed, async () => undefined), true);

    // J65: a manual retry forgets the settlement, so the next failure settles again.
    await broker.retry(job.id);
    await claimEventually("github");
    const refailed = await broker.failTerminal(job.id, providerError);
    assert.equal(await broker.settleFailure(refailed, async () => undefined), true);
  });

  await t.test("RL29: queued jobs count only on queues a live watcher serves; active jobs always", async () => {
    await broker.create("answer_question", codexAnswer("orphan-1"));
    await broker.create("answer_question", codexAnswer("orphan-2"));
    assert.equal(await broker.countInFlight(["answer_question"]), 2, "no live set: every queued job counts");
    assert.equal(await broker.countInFlight(["answer_question"], ["claude"]), 0);
    assert.equal(await broker.countInFlight(["answer_question"], ["codex"]), 2);

    const capacity = { types: ["answer_question" as const], limit: 1, servedCapabilities: ["claude" as const] };
    const admitted = await broker.createIfAdmitted("answer_question", codexAnswer("admitted"), capacity);
    assert.equal(admitted.admitted, true, "an orphaned backlog does not hold the ceiling shut");

    await claimEventually("codex");
    assert.equal(await broker.countInFlight(["answer_question"], []), 1, "an active job always counts");
  });

  await t.test("J66: a scheduled tick's queued lifetime is one cron interval", async () => {
    await broker.reconcileSchedules([
      {
        type: "correctness_patrol",
        key: "task:correctness-patrol::docs",
        cron: "*/10 * * * *",
        input: { flowId: "docs" },
        enabled: true
      }
    ]);
    const rows = await pool.query<{ retention: number }>(
      `SELECT (options->>'retentionSeconds')::int AS retention FROM "${lifecycleSchema}".schedule WHERE name = $1`,
      ["correctness_patrol"]
    );
    assert.deepEqual(
      rows.rows.map((row) => row.retention),
      [600]
    );
    await broker.reconcileSchedules([]);
  });
});
