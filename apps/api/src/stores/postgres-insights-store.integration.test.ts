import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { PostgresInsightsStore } from "./postgres-insights-store.js";

// DB-backed rollup tests for the insights SQL. Gated by RUN_PG_INTEGRATION so the
// default unit run stays database-free (see writing-magpie-tests skill).
const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/markdown_magpie";

// A minimal pg-boss-shaped pair of tables (job + archive) in a throwaway schema.
// The throughput/latency rollups only read `name`, `state`, `created_on` (and
// `completed_on` for latency), so we replicate just those columns rather than
// standing up a full pg-boss instance.
const DDL = (schema: string) => `
  CREATE SCHEMA "${schema}";
  CREATE TABLE "${schema}".job     (name text, state text, created_on timestamptz, completed_on timestamptz);
  CREATE TABLE "${schema}".archive (name text, state text, created_on timestamptz, completed_on timestamptz);
`;

test("gapBacklog buckets question_gaps by day", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const store = new PostgresInsightsStore(pool, "pgboss");

  const q = "insights-test-q1";
  await pool.query("DELETE FROM question_gaps WHERE question_id = $1", [q]);
  await pool.query("DELETE FROM questions WHERE id = $1", [q]);
  await pool.query(
    "INSERT INTO questions (id, question, chat_provider, asked_at) VALUES ($1, 'q', 'mock', now())",
    [q]
  );
  await pool.query(
    "INSERT INTO question_gaps (question_id, summary, created_at, resolved_at) VALUES ($1,'a',now(),NULL),($1,'b',now(),now())",
    [q]
  );

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  const rows = await store.gapBacklog({ from, to, bucket: "day" });

  const today = rows.at(-1);
  assert.ok(today);
  assert.equal(today.opened, 2);
  assert.equal(today.resolved, 1);
});

test("jobThroughput unions job + archive and buckets by state", { skip: !runIntegration }, async (t) => {
  const schema = `insights_pgboss_test_${process.pid}`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.query(DDL(schema));

  // Completed/failed rows have migrated to archive; active/retry are still live in
  // job. All created "today". A completed row scoped to another queue name exercises
  // the `type` filter.
  await pool.query(
    `INSERT INTO "${schema}".job (name, state, created_on) VALUES
       ('answer_question', 'active', now()),
       ('answer_question', 'created', now()),
       ('answer_question', 'retry', now())`
  );
  await pool.query(
    `INSERT INTO "${schema}".archive (name, state, created_on) VALUES
       ('answer_question', 'completed', now()),
       ('answer_question', 'completed', now()),
       ('answer_question', 'failed', now()),
       ('other_queue', 'completed', now())`
  );

  const store = new PostgresInsightsStore(pool, schema);
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);

  const all = await store.jobThroughput({ from, to, bucket: "day" });
  const today = all.at(-1);
  assert.ok(today);
  assert.equal(today.completed, 3); // 2 answer_question + 1 other_queue, from archive
  assert.equal(today.failed, 1);
  assert.equal(today.active, 2); // active + created folded together
  assert.equal(today.retry, 1);

  // `type` filter narrows to one queue's rows only.
  const scoped = await store.jobThroughput({ from, to, bucket: "day" }, ["answer_question"]);
  const scopedToday = scoped.at(-1);
  assert.ok(scopedToday);
  assert.equal(scopedToday.completed, 2);

  // An empty queue-name list (unknown type) matches nothing.
  const none = await store.jobThroughput({ from, to, bucket: "day" }, []);
  assert.ok(none.every((bucket) => bucket.completed + bucket.failed + bucket.active + bucket.retry === 0));
});

test("verificationSuccess splits gap_closure_verification by verdict", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const store = new PostgresInsightsStore(pool, "pgboss");

  // gap_closure_verification.proposal_id has a FK to proposals(id), so seed a
  // proposal first, then two verification rows (one closed, one still_open).
  const proposalId = "insights-test-p1";
  await pool.query("DELETE FROM gap_closure_verification WHERE proposal_id = $1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [proposalId]);
  await pool.query(
    "INSERT INTO proposals (id, title, status, target_path, markdown) VALUES ($1, 't', 'merged', 'p.md', '#')",
    [proposalId]
  );
  await pool.query(
    `INSERT INTO gap_closure_verification
       (id, proposal_id, question_id, verdict, confidence, cited_merged_doc, created_at)
     VALUES
       ('insights-test-v1', $1, 'q1', 'closed',     'high', true,  now()),
       ('insights-test-v2', $1, 'q2', 'still_open', 'low',  false, now())`,
    [proposalId]
  );

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  const result = await store.verificationSuccess({ from, to, bucket: "day" });

  assert.ok(result.totals.closed >= 1);
  assert.ok(result.totals.stillOpen >= 1);
  const today = result.series.at(-1);
  assert.ok(today, "expected at least one zero-filled bucket");
});

test("answerLatency bins completed answer_question jobs", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const store = new PostgresInsightsStore(pool, "pgboss");

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  const bins = await store.answerLatency({ from, to, bucket: "day" });

  // The histogram always returns every fixed bin (zero-filled), regardless of
  // whether any pg-boss answer_question rows exist in the window.
  assert.equal(bins.length, 7);
  assert.equal(bins[0]?.label, "0–5s");
  assert.equal(bins.at(-1)?.to, null);
  for (const bin of bins) assert.ok(bin.count >= 0);
});
