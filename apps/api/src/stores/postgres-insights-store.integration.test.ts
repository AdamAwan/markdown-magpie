import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { PostgresInsightsStore } from "./postgres-insights-store.js";

// DB-backed rollup tests for the insights SQL. Gated by RUN_PG_INTEGRATION so the
// default unit run stays database-free (see writing-magpie-tests skill).
const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/markdown_magpie";

// A minimal pg-boss-shaped `job` table in a throwaway schema. pg-boss v12 keeps
// finished jobs in `job` until retention purges them (there is no `archive` table),
// so a single table is a faithful stand-in. The throughput/latency/error rollups
// only read `name`, `state`, `created_on`, `completed_on`, and `output`, so we
// replicate just those columns rather than standing up a full pg-boss instance.
const DDL = (schema: string) => `
  CREATE SCHEMA "${schema}";
  CREATE TABLE "${schema}".job (name text, state text, created_on timestamptz, completed_on timestamptz, output jsonb);
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

test("jobThroughput buckets job rows by state", { skip: !runIntegration }, async (t) => {
  const schema = `insights_pgboss_test_${process.pid}`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.query(DDL(schema));

  // Every state — live and finished — lives in the single `job` table. All created
  // "today". A completed row scoped to another queue name exercises the `type`
  // filter.
  await pool.query(
    `INSERT INTO "${schema}".job (name, state, created_on) VALUES
       ('answer_question', 'active', now()),
       ('answer_question', 'created', now()),
       ('answer_question', 'retry', now()),
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
  assert.equal(today.completed, 3); // 2 answer_question + 1 other_queue
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

test("journey builds the branching Sankey from real domain rows", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const store = new PostgresInsightsStore(pool, "pgboss");

  // Isolate the fixture with a dedicated flow_id so the flow-scoped query ignores
  // whatever else lives in the shared database.
  const flow = "insights-journey-test";
  const proposalId = "insights-journey-p1";
  await pool.query("DELETE FROM proposals WHERE flow_id = $1", [flow]);
  await pool.query(
    "DELETE FROM question_gaps WHERE question_id IN (SELECT id FROM questions WHERE flow_id = $1)",
    [flow]
  );
  await pool.query("DELETE FROM gap_clusters WHERE flow_id = $1", [flow]);
  await pool.query("DELETE FROM questions WHERE flow_id = $1", [flow]);

  // Two high-confidence questions (one raises a gap, one does not) and one
  // low-confidence question that raises a gap.
  await pool.query(
    `INSERT INTO questions (id, question, chat_provider, confidence, flow_id, asked_at) VALUES
       ('ijq1', 'q', 'mock', 'high', $1, now()),
       ('ijq2', 'q', 'mock', 'low',  $1, now()),
       ('ijq3', 'q', 'mock', 'high', $1, now())`,
    [flow]
  );
  await pool.query(
    "INSERT INTO question_gaps (question_id, summary, created_at, dismissed_at) VALUES ('ijq1','a',now(),now())"
  );
  const clustered = await pool.query<{ id: string }>(
    "INSERT INTO question_gaps (question_id, summary, created_at) VALUES ('ijq2','b',now()) RETURNING id"
  );

  const cluster = await pool.query<{ id: string }>(
    "INSERT INTO gap_clusters (flow_id, title, status) VALUES ($1, 'c', 'active') RETURNING id",
    [flow]
  );
  await pool.query(
    "INSERT INTO gap_cluster_memberships (cluster_id, gap_id, active) VALUES ($1, $2, true)",
    [cluster.rows[0].id, clustered.rows[0].id]
  );
  // Two proposals off the single cluster: one merged, one still a draft. This makes
  // prop_total (2) differ from gap_clustered (1) so the boundary link can be asserted
  // to follow the gap-side count, not the proposal count.
  await pool.query(
    `INSERT INTO proposals (id, title, status, target_path, markdown, gap_cluster_id, closure_status, flow_id, created_at)
     VALUES ($1, 't', 'merged', 'p.md', '#', $2, 'verified_closed', $3, now()),
            ($4, 't', 'draft',  'p2.md', '#', $2, NULL,              $3, now())`,
    [proposalId, cluster.rows[0].id, flow, `${proposalId}-2`]
  );

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  const { nodes, links } = await store.journey({ from, to, bucket: "day" }, flow);

  const value = (source: string, target: string): number =>
    links.find((link) => link.source === source && link.target === target)?.value ?? 0;

  assert.equal(value("questions", "conf_high"), 2);
  assert.equal(value("questions", "conf_low"), 1);
  assert.equal(value("conf_high", "no_gap"), 1); // ijq3 answered without a gap
  assert.equal(value("conf_high", "gaps"), 1); // ijq1's gap
  assert.equal(value("conf_low", "gaps"), 1); // ijq2's gap
  assert.equal(value("gaps", "gap_dismissed"), 1);
  assert.equal(value("gaps", "clustered"), 1);
  // The gap→proposal boundary link carries the gap-side count (1 clustered gap), not
  // prop_total (2 proposals) — that keeps "Clustered" conserved. The unit shift to
  // prop_total surfaces at "Proposals drafted", whose status arms sum to 2.
  assert.equal(value("clustered", "proposals"), 1);
  assert.equal(value("proposals", "prop_inprogress"), 1); // the draft
  assert.equal(value("proposals", "merged"), 1);
  assert.equal(value("merged", "v_closed"), 1);

  // Only positive links survive, and every node they reference is present.
  assert.ok(links.every((link) => link.value > 0));
  const keys = new Set(nodes.map((node) => node.key));
  for (const link of links) {
    assert.ok(keys.has(link.source));
    assert.ok(keys.has(link.target));
  }
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

test("jobErrors splits failed job rows by category and job type", { skip: !runIntegration }, async (t) => {
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
       ('answer_question__claude', 'active', now(), NULL),
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

test("aiUsage sums completion-envelope usage per (job type, provider)", { skip: !runIntegration }, async (t) => {
  const schema = `insights_pgboss_usage_test_${process.pid}`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.query(DDL(schema));

  // Completed AI-queue rows carry the { result, executor, usage, model }
  // envelope in `output` (#241, #268); usage is absent when the provider
  // reported nothing (CLI tiers) and model is absent when the watcher had none
  // configured. Non-AI queues (publish_proposal__github), failed rows, and
  // dead-letter twins must all be ignored. The two openai_compatible
  // answer_question rows share model "gpt-4o" so they group together and price
  // as one priced row.
  await pool.query(
    `INSERT INTO "${schema}".job (name, state, created_on, output) VALUES
       ('answer_question__openai_compatible', 'completed', now(),
        '{"result":{},"executor":"w1","provider":"openai-compatible","model":"gpt-4o","usage":{"inputTokens":100,"outputTokens":20,"totalTokens":120}}'::jsonb),
       ('answer_question__openai_compatible', 'completed', now(),
        '{"result":{},"executor":"w1","provider":"openai-compatible","model":"gpt-4o","usage":{"inputTokens":40,"outputTokens":5,"totalTokens":45}}'::jsonb),
       ('answer_question__claude', 'completed', now(), '{"result":{},"executor":"w2","provider":"claude"}'::jsonb),
       ('verify_document__openai_compatible', 'completed', now(),
        '{"result":{},"executor":"w1","provider":"openai-compatible","model":"gpt-4o-mini","usage":{"inputTokens":7,"outputTokens":3,"totalTokens":10}}'::jsonb),
       ('verify_document__claude', 'completed', now(),
        '{"result":{},"executor":"w2","provider":"claude","usage":{"inputTokens":50,"outputTokens":10}}'::jsonb),
       ('answer_question__openai_compatible', 'failed', now(), '{"category":"provider"}'::jsonb),
       ('answer_question__openai_compatible__dead_letter', 'completed', now(),
        '{"result":{},"executor":"w1","provider":"openai-compatible","model":"gpt-4o","usage":{"inputTokens":999,"outputTokens":999,"totalTokens":1998}}'::jsonb),
       ('publish_proposal__github', 'completed', now(), '{"result":{},"executor":"w2"}'::jsonb)`
  );

  const store = new PostgresInsightsStore(pool, schema);
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  // Only gpt-4o on openai-compatible is priced; gpt-4o-mini and the CLI rows are
  // not, so they must come back without an estimatedCost (never priced as $0).
  const usage = await store.aiUsage({ from, to, bucket: "day" }, [
    { provider: "openai-compatible", model: "gpt-4o", inputPerMTok: 2.5, outputPerMTok: 10 }
  ]);

  // Heaviest triple first. Three states are distinguishable:
  //  - priced   — answer_question/openai-compatible/gpt-4o: (140×2.5 + 25×10)/1e6
  //  - unpriced — verify_document rows: usage reported (jobsWithUsage 1) but no
  //               matching price entry (gpt-4o-mini) or no model at all (claude,
  //               model absent), so estimatedCost is omitted. The claude row
  //               reported no totalTokens, so its total falls back to in+out (60).
  //  - unmetered — answer_question/claude: no usage at all (jobsWithUsage 0), so
  //               it counts as a job, contributes no tokens, and carries no cost.
  assert.deepEqual(usage, [
    {
      jobType: "answer_question",
      provider: "openai-compatible",
      model: "gpt-4o",
      jobs: 2,
      jobsWithUsage: 2,
      inputTokens: 140,
      outputTokens: 25,
      totalTokens: 165,
      estimatedCost: 0.0006
    },
    {
      jobType: "verify_document",
      provider: "claude",
      jobs: 1,
      jobsWithUsage: 1,
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60
    },
    {
      jobType: "verify_document",
      provider: "openai-compatible",
      model: "gpt-4o-mini",
      jobs: 1,
      jobsWithUsage: 1,
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10
    },
    {
      jobType: "answer_question",
      provider: "claude",
      jobs: 1,
      jobsWithUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
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

test("answerFeedback splits verdicts with the unhelpful-on-confident subset", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const store = new PostgresInsightsStore(pool, "pgboss");

  // Scope every row (and the query) to a unique flow so parallel rows from other
  // tests can never leak into the counts — and the flow filter is exercised.
  const flowId = `insights-test-feedback-${process.pid}`;
  const ids = [1, 2, 3, 4, 5].map((n) => `insights-test-fb-${n}`);
  await pool.query("DELETE FROM questions WHERE id = ANY($1)", [ids]);
  // helpful/high, unhelpful/medium (confident), unhelpful/low, unhelpful on a
  // verification re-ask (excluded), and helpful/unknown.
  await pool.query(
    `INSERT INTO questions (id, question, chat_provider, asked_at, confidence, feedback, feedback_at, flow_id, purpose) VALUES
       ($1, 'q', 'mock', now(), 'high',    'helpful',   now(), $6, 'live'),
       ($2, 'q', 'mock', now(), 'medium',  'unhelpful', now(), $6, 'live'),
       ($3, 'q', 'mock', now(), 'low',     'unhelpful', now(), $6, 'live'),
       ($4, 'q', 'mock', now(), 'high',    'unhelpful', now(), $6, 'verification'),
       ($5, 'q', 'mock', now(), 'unknown', 'helpful',   now(), $6, 'live')`,
    [...ids, flowId]
  );

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  const { totals, series } = await store.answerFeedback({ from, to, bucket: "day" }, flowId);

  assert.equal(totals.helpful, 2);
  assert.equal(totals.unhelpful, 2, "the verification re-ask is excluded");
  assert.equal(totals.unhelpfulConfident, 1, "only the medium/high unhelpful counts as confident");

  const today = series.at(-1);
  assert.ok(today);
  assert.equal(today.helpful, 2);
  assert.equal(today.unhelpful, 2);
  assert.equal(today.unhelpfulConfident, 1);

  // Zero-filled: every day in the window is present.
  assert.equal(series.length, 8);
});
