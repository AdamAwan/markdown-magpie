import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobError } from "@magpie/jobs";
import pg from "pg";
import { PgBossJobBroker } from "../jobs/pg-boss-broker.js";
import { createQueueStatsReader } from "./queue-stats.js";

// Runs the queue-health stats statement against a real pg-boss schema (the
// broker provisions it), so the SQL is checked against pg-boss's actual job and
// schedule tables, not a hand-made stand-in. Gated by RUN_PG_INTEGRATION; run via
// `npm run test:db`.
const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/markdown_magpie";
const bossSchema = `pgboss_qstats_${process.pid}`;
// watcher_registrations is unqualified in the stats SQL, so a per-process copy
// earlier on the search_path isolates this test from other suites (the watcher
// registry tests DELETE every row) running concurrently on the same database.
const watcherSchema = `qstats_watchers_${process.pid}`;

const providerError: JobError = { code: "provider_error", message: "boom", category: "provider" };

const answerInput = (provider: "codex" | "claude", question: string) => ({
  provider,
  question,
  flows: [],
  expectedOutput: "answer_result" as const
});

test(
  "queue stats read ready/oldest/dead-letter, watchers and schedules from real pg-boss tables",
  {
    skip: !runIntegration
  },
  async (t) => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`DROP SCHEMA IF EXISTS "${watcherSchema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${watcherSchema}"`);
    await admin.query(
      `CREATE TABLE "${watcherSchema}".watcher_registrations (LIKE public.watcher_registrations INCLUDING ALL)`
    );
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${watcherSchema},public` });
    const broker = new PgBossJobBroker({ connectionString: databaseUrl, pool, schema: bossSchema });
    await broker.start();
    t.after(async () => {
      await broker.stop();
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${watcherSchema}" CASCADE`);
      await admin.end();
    });

    const read = createQueueStatsReader({ pool, pgBossSchema: bossSchema, watcherActiveWindowMs: 60_000 });

    // One job parked in dead-letter: claimed (the only job yet) and terminal-failed.
    const doomed = await broker.create("answer_question", answerInput("codex", "doomed"));
    assert.equal((await broker.claim("w", ["codex"]))?.id, doomed.id);
    await broker.failTerminal(doomed.id, providerError);

    // Two claimable answer jobs on two provider queues, one backdated 5 minutes so
    // the oldest-ready age is observable. The active/failed doomed job is not ready.
    const old = await broker.create("answer_question", answerInput("codex", "old"));
    await broker.create("answer_question", answerInput("claude", "new"));
    await pool.query(
      `UPDATE "${bossSchema}".job SET start_after = now() - interval '5 minutes', created_on = now() - interval '5 minutes'
      WHERE id = $1`,
      [old.id]
    );

    // Watchers: two live (one with codex), one long silent.
    await pool.query(
      `INSERT INTO watcher_registrations (name, status, capabilities, last_seen_at) VALUES
       ('w1', 'idle', '{maintenance,codex}', now()),
       ('w2', 'busy', '{maintenance}', now()),
       ('w3', 'idle', '{github}', now() - interval '2 hours')`
    );

    // A schedule created an hour ago that has never completed a run.
    await broker.reconcileSchedules([
      {
        type: "refresh_flow_snapshot",
        key: "task:snapshot-refresh::all",
        cron: "*/30 * * * *",
        input: {},
        enabled: true
      }
    ]);
    await pool.query(`UPDATE "${bossSchema}".schedule SET created_on = now() - interval '1 hour'`);

    const before = await read();
    assert.ok(before);
    const answer = before.jobTypes.find((row) => row.jobType === "answer_question");
    assert.equal(answer?.ready, 2);
    assert.equal(answer?.deadLetter, 1);
    assert.ok(answer && answer.oldestReadyAgeSeconds >= 299 && answer.oldestReadyAgeSeconds < 400);
    assert.equal(before.watchers.connected, 2);
    const capabilities = new Map(before.watchers.byCapability.map((row) => [row.capability, row.connected]));
    assert.equal(capabilities.get("maintenance"), 2);
    assert.equal(capabilities.get("codex"), 1);
    assert.equal(capabilities.get("github"), 0, "a watcher outside the active window is not counted");
    assert.equal(before.schedules.length, 1);
    assert.equal(before.schedules[0]?.key, "task:snapshot-refresh::all");
    assert.equal(before.schedules[0]?.jobType, "refresh_flow_snapshot");
    assert.ok((before.schedules[0]?.lastSuccessAgeSeconds ?? 0) >= 3599, "never succeeded: age since creation");

    // A completed run of the scheduled job (same queue + input) resets the age.
    await broker.create("refresh_flow_snapshot", {});
    const snapshotJob = await broker.claim("gh", ["github"]);
    assert.ok(snapshotJob);
    await broker.complete(snapshotJob.id, {});
    const after = await read();
    assert.ok(after);
    assert.ok((after.schedules[0]?.lastSuccessAgeSeconds ?? Infinity) < 60);
  }
);
