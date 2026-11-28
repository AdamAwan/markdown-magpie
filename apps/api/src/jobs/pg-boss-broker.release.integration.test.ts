import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobError, JobView } from "@magpie/jobs";
import { Pool } from "pg";
import { PgBossJobBroker } from "./pg-boss-broker.js";

// docs/ai-jobs.md J53: a watcher shutting down mid-job releases its claim. The
// released attempt must not count against the retry budget — pg-boss counts an
// attempt at claim time (fetchNextJob bumps retry_count when started_on is set),
// so this is only provable against the real broker.

const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/markdown_magpie";
const schema = `pgboss_release_test_${process.pid}`;

const codexAnswer = (question: string) => ({
  provider: "codex" as const,
  question,
  flows: [],
  expectedOutput: "answer_result" as const
});

const providerError: JobError = { code: "provider_error", message: "Provider failed", category: "provider" };

test("pg-boss broker releases a claimed job without spending a retry", { skip: !runIntegration }, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const broker = new PgBossJobBroker({
    connectionString: databaseUrl,
    pool,
    schema,
    // One retry, no backoff wait beyond a second, so the budget is easy to exhaust.
    queuePolicyOverrides: { retryLimit: 1, retryDelay: 1, retryBackoff: false }
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

  // Claims the next codex job, waiting out a retry's start_after when needed.
  async function claimNext(): Promise<JobView | undefined> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const job = await broker.claim("worker", ["codex"]);
      if (job || Date.now() >= deadline) return job;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  await t.test("a released first attempt is claimable at once and keeps retryCount 0", async () => {
    const created = await broker.create("answer_question", codexAnswer("release"));
    const claimed = await broker.claim("worker", ["codex"]);
    assert.equal(claimed?.id, created.id);

    const released = await broker.release(created.id);
    assert.equal(released.state, "created");
    assert.equal(released.retryCount, 0);
    assert.equal(released.startedAt, undefined);

    // Immediately claimable (start_after moved to now, not a backoff).
    const reclaimed = await broker.claim("worker", ["codex"]);
    assert.equal(reclaimed?.id, created.id);
    assert.equal(reclaimed?.retryCount, 0, "the released attempt was not counted");
  });

  await t.test("a fenced release leaves an attempt it does not hold claimed (J60)", async () => {
    const created = await broker.create("answer_question", codexAnswer("release-fence"));
    const claimed = await broker.claim("worker", ["codex"]);
    assert.equal(claimed?.id, created.id);

    const stale = await broker.release(created.id, { attempt: (claimed?.retryCount ?? 0) + 1 });
    assert.equal(stale.state, "active", "a release for another attempt is a no-op");

    const released = await broker.release(created.id, { attempt: claimed?.retryCount });
    assert.equal(released.state, "created");
    assert.equal((await broker.claim("worker", ["codex"]))?.id, created.id);
    await broker.complete(created.id, {});
  });

  await t.test("repeated releases never exhaust the retry budget", async () => {
    const created = await broker.create("answer_question", codexAnswer("budget"));
    // Two claim+release cycles: if each claim counted, retry_count would already
    // be at the limit and the fail below would be terminal.
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await claimNext())?.id, created.id);
      await broker.release(created.id);
    }
    assert.equal((await claimNext())?.id, created.id);
    const failed = await broker.fail(created.id, providerError);
    assert.equal(failed.state, "retry", "the one real retry is still available");

    // That retry runs, is released (state goes back to `retry`, count kept),
    // and its next claim still counts as the same attempt.
    const retried = await claimNext();
    assert.equal(retried?.retryCount, 1);
    const releasedRetry = await broker.release(created.id);
    assert.equal(releasedRetry.state, "retry");
    assert.equal(releasedRetry.retryCount, 1);
    const again = await claimNext();
    assert.equal(again?.retryCount, 1);
    // Budget now spent by the one real failure + this real one: terminal.
    assert.equal((await broker.fail(created.id, providerError)).state, "failed");
  });

  await t.test("is a no-op on a job that is not active", async () => {
    const queued = await broker.create("answer_question", codexAnswer("queued"));
    assert.equal((await broker.release(queued.id)).state, "created");
    await broker.cancel(queued.id);

    const created = await broker.create("answer_question", codexAnswer("cancelled"));
    assert.equal((await claimNext())?.id, created.id);
    await broker.cancel(created.id);
    assert.equal((await broker.release(created.id)).state, "cancelled");
  });
});
