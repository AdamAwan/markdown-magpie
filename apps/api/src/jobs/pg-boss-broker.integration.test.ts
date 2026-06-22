import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobError } from "@magpie/jobs";
import { Pool } from "pg";
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
  const broker = new PgBossJobBroker({ connectionString: databaseUrl, schema });
  t.before(() => broker.start());
  t.beforeEach(() => broker.reset());
  t.after(async () => {
    await broker.reset();
    await broker.stop();
    const pool = new Pool({ connectionString: databaseUrl });
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

  await t.test("rotates fairly across accepted queues", async () => {
    const answerOne = await broker.create("answer_question", codexAnswer("answer-one"));
    const answerTwo = await broker.create("answer_question", codexAnswer("answer-two"));
    const proposal = await broker.create("draft_markdown_proposal", {
      provider: "codex",
      gapSummaries: ["gap"],
      triggeringQuestions: ["question"],
      evidence: [],
      expectedOutput: "markdown_proposal"
    });

    const claimed = [];
    for (let index = 0; index < 3; index += 1) {
      const job = await broker.claim("multipurpose", ["codex"]);
      assert.ok(job);
      claimed.push(job);
    }
    assert.deepEqual(new Set(claimed.slice(0, 2).map((job) => job.queueName)), new Set([
      "answer_question__codex",
      "draft_markdown_proposal__codex"
    ]));
    assert.deepEqual(new Set(claimed.map((job) => job.id)), new Set([answerOne.id, answerTwo.id, proposal.id]));
    for (const job of claimed) {
      await broker.cancel(job.id);
    }
  });

  await t.test("touches, retries failures, completes, cancels, and manually retries", async () => {
    const retrying = await broker.create("answer_question", codexAnswer("retry"));
    const active = await broker.claim("worker", ["codex"]);
    assert.equal(active?.id, retrying.id);
    const heartbeat = await broker.heartbeat(retrying.id);
    assert.equal(heartbeat.state, "active");
    assert.ok(heartbeat.heartbeatAt);

    const failedAttempt = await broker.fail(retrying.id, providerError);
    assert.equal(failedAttempt.state, "retry");
    assert.equal(failedAttempt.retryCount, 0);

    let claimedRetry;
    const deadline = Date.now() + 40_000;
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

    const exhausted = await broker.create("refresh_pull_requests", {});
    let claimed = await broker.claim("github-worker", ["github"]);
    for (let attempt = 0; attempt <= exhausted.retryLimit; attempt += 1) {
      assert.equal(claimed?.id, exhausted.id);
      const failed = await broker.fail(exhausted.id, providerError);
      if (attempt < exhausted.retryLimit) {
        assert.equal(failed.state, "retry");
        claimed = undefined;
        const retryDeadline = Date.now() + 180_000;
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

  await t.test("filters lists and resets jobs", async () => {
    await broker.create("answer_question", codexAnswer("listed"));
    await broker.create("refresh_pull_requests", {});
    const listed = await broker.list({ type: "answer_question", state: "created", limit: 1, offset: 0 });
    assert.equal(listed.jobs.length, 1);
    assert.ok(listed.total >= 1);
    assert.equal(listed.jobs[0]?.type, "answer_question");
  });

  await t.test("reconciles schedules idempotently and removes stale schedules", async () => {
    const desired = [{
      type: "trigger_scheduled_crunch" as const,
      key: "flow:docs",
      cron: "*/5 * * * *",
      input: { flowId: "docs" },
      enabled: true
    }];
    await broker.reconcileSchedules(desired);
    await broker.reconcileSchedules(desired);
    assert.deepEqual((await broker.listSchedules()).map(({ key, type, cron, enabled }) => ({ key, type, cron, enabled })), [{
      key: "flow:docs",
      type: "trigger_scheduled_crunch",
      cron: "*/5 * * * *",
      enabled: true
    }]);

    await broker.reconcileSchedules([]);
    assert.deepEqual(await broker.listSchedules(), []);
  });

  await broker.reset();
  assert.equal((await broker.list({})).total, 0);
});
