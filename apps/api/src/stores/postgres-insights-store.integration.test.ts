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
  CREATE TABLE "${schema}".job     (name text, state text, created_on timestamptz, completed_on timestamptz, output jsonb);
  CREATE TABLE "${schema}".archive (name text, state text, created_on timestamptz, completed_on timestamptz, output jsonb);
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

test("jobErrors splits failed job/archive rows by category and job type", { skip: !runIntegration }, async (t) => {
  const schema = `insights_pgboss_err_test_${process.pid}`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.query(DDL(schema));

  // Failed rows carry the JobError payload in `output`; the queue `name` is
  // `<type>__<capability>` for fan-out queues. A completed row must be ignored.
  await pool.query(
    `INSERT INTO "${schema}".job (name, state, created_on, output) VALUES
       ('answer_question__claude', 'failed', now(), '{"category":"provider"}'::jsonb),
       ('answer_question__claude', 'active', now(), NULL)`
  );
  await pool.query(
    `INSERT INTO "${schema}".archive (name, state, created_on, output) VALUES
       ('answer_question__codex', 'failed', now(), '{"category":"provider"}'::jsonb),
       ('publish_proposal__github', 'failed', now(), '{"category":"external"}'::jsonb),
       ('answer_question__claude', 'completed', now(), NULL)`
  );

  const store = new PostgresInsightsStore(pool, schema);
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  const { byCategory, byType } = await store.jobErrors({ from, to, bucket: "day" });

  // 3 failed rows: 2 provider + 1 external.
  assert.deepEqual(byCategory, [
    { key: "provider", count: 2 },
    { key: "external", count: 1 }
  ]);
  // Fan-out suffix stripped: answer_question (2) + publish_proposal (1).
  assert.deepEqual(byType, [
    { key: "answer_question", count: 2 },
    { key: "publish_proposal", count: 1 }
  ]);
});

test("freshness classifies documents by review cadence and sources by last sync", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const store = new PostgresInsightsStore(pool, "pgboss");

  const repoId = "insights-test-repo";
  await pool.query("DELETE FROM documents WHERE repository_id = $1", [repoId]);
  await pool.query("DELETE FROM repositories WHERE id = $1", [repoId]);
  await pool.query(
    `INSERT INTO repositories (id, name, default_branch, local_path, provider)
     VALUES ($1, 'r', 'main', '/tmp/r', 'local') ON CONFLICT (id) DO NOTHING`,
    [repoId]
  );
  // fresh: verified today, 30-day cycle. due: verified 28 days ago, 30-day cycle
  // (next review in 2 days, inside the 7-day soon-window). overdue: verified 60
  // days ago, 30-day cycle. no-cadence doc is excluded.
  await pool.query(
    `INSERT INTO documents (id, repository_id, path, title, status, last_verified, review_cycle_days, content) VALUES
       ('insights-doc-fresh',   $1, 'a.md', 'a', 'active', current_date,             30, '#'),
       ('insights-doc-due',     $1, 'b.md', 'b', 'active', current_date - 28,        30, '#'),
       ('insights-doc-overdue', $1, 'c.md', 'c', 'active', current_date - 60,        30, '#'),
       ('insights-doc-nocycle', $1, 'd.md', 'd', 'active', current_date,           NULL, '#')`,
    [repoId]
  );

  const sourceId = "insights-test-source";
  await pool.query("DELETE FROM source_sync_state WHERE source_id = $1", [sourceId]);
  await pool.query(
    `INSERT INTO source_sync_state (flow_id, source_id, last_sha, last_checked_at) VALUES
       ('insights-flow-a', $1, 'sha1', now()),
       ('insights-flow-b', $1, 'sha2', now() - interval '30 days')`,
    [sourceId]
  );

  const result = await store.freshness();
  assert.ok(result.documents.fresh >= 1);
  assert.ok(result.documents.due >= 1);
  assert.ok(result.documents.overdue >= 1);
  assert.ok(result.sources.fresh >= 1);
  assert.ok(result.sources.stale >= 1);
});

test("patrolImpact aggregates findings and proposals per task type", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const store = new PostgresInsightsStore(pool, "pgboss");

  await pool.query("DELETE FROM maintenance_runs WHERE id LIKE 'insights-test-mr-%'");
  await pool.query(
    `INSERT INTO maintenance_runs (id, task_type, trigger, status, summary, details, started_at) VALUES
       ('insights-test-mr-1', 'correctness_patrol', 'scheduled', 'completed', 's',
         '{"findings":[{"path":"a"},{"path":"b"}]}'::jsonb, now()),
       ('insights-test-mr-2', 'correctness_patrol', 'scheduled', 'completed', 's',
         '{"findings":[{"path":"c"}]}'::jsonb, now()),
       ('insights-test-mr-3', 'process_gaps_to_pull_requests', 'scheduled', 'completed', 's',
         '{"proposalsDrafted":4}'::jsonb, now())`
  );

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  const runs = await store.patrolImpact({ from, to, bucket: "day" });

  const patrol = runs.find((row) => row.taskType === "correctness_patrol");
  assert.ok(patrol);
  assert.ok(patrol.runs >= 2);
  assert.ok(patrol.findings >= 3);

  const gapToPr = runs.find((row) => row.taskType === "process_gaps_to_pull_requests");
  assert.ok(gapToPr);
  assert.ok(gapToPr.proposals >= 4);
});
