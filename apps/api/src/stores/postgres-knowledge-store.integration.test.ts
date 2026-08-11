import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";

// DB-backed tests for the keyword-search SQL. Gated by RUN_PG_INTEGRATION so the
// default unit run stays database-free (see the writing-magpie-tests skill).
const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/markdown_magpie";

// Inserts one repository + document + section and returns the section id.
// Each caller gets a unique repository id so parallel tests cannot collide.
async function seedSection(
  pool: pg.Pool,
  section: { heading: string; headingPath: string[]; path: string; content: string }
): Promise<{ sectionId: string; repositoryId: string }> {
  const repositoryId = `kw-${randomUUID()}`;
  const documentId = `${repositoryId}:${section.path}`;
  const sectionId = `${documentId}#0`;
  await pool.query(
    "INSERT INTO repositories (id, name, default_branch, local_path, provider) VALUES ($1, $1, 'main', '/tmp', 'local')",
    [repositoryId]
  );
  await pool.query("INSERT INTO documents (id, repository_id, path, title, content) VALUES ($1, $2, $3, $4, $5)", [
    documentId,
    repositoryId,
    section.path,
    section.heading,
    section.content
  ]);
  await pool.query(
    `INSERT INTO document_sections (id, document_id, path, heading, heading_path, anchor, content, ordinal)
     VALUES ($1, $2, $3, $4, $5, 'a', $6, 0)`,
    [sectionId, documentId, section.path, section.heading, section.headingPath, section.content]
  );
  return { sectionId, repositoryId };
}

test("search_tsv indexes heading_path and path, weighted", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  const { sectionId, repositoryId } = await seedSection(pool, {
    heading: "Annual plans",
    headingPath: ["Billing", "Refunds"],
    path: "billing/cancellation-policy.md",
    content: "Customers on yearly agreements receive credit."
  });
  // Registered in teardown order: node:test runs t.after hooks in registration
  // order, so the delete (which needs a live pool) must be added before the
  // pool.end() hook. documents has no ON DELETE CASCADE from repositories, so
  // documents (and its cascading document_sections) must go first.
  t.after(async () => {
    await pool.query("DELETE FROM documents WHERE repository_id = $1", [repositoryId]);
    await pool.query("DELETE FROM repositories WHERE id = $1", [repositoryId]);
  });
  t.after(() => pool.end());

  // "refunds" appears ONLY in heading_path; "cancellation" ONLY in the file path.
  const found = await pool.query<{ id: string }>(
    `SELECT id FROM document_sections
     WHERE id = $1 AND search_tsv @@ websearch_to_tsquery('english', 'refunds cancellation')`,
    [sectionId]
  );
  assert.equal(found.rowCount, 1, "heading_path and path must be searchable");

  // The heading term must outrank a body term: weight A beats weight C.
  const ranks = await pool.query<{ heading_rank: string; body_rank: string }>(
    `SELECT ts_rank_cd('{0.1,0.3,0.6,1.0}'::float4[], search_tsv, websearch_to_tsquery('english','annual')) AS heading_rank,
            ts_rank_cd('{0.1,0.3,0.6,1.0}'::float4[], search_tsv, websearch_to_tsquery('english','credit'))  AS body_rank
     FROM document_sections WHERE id = $1`,
    [sectionId]
  );
  assert.ok(
    Number(ranks.rows[0].heading_rank) > Number(ranks.rows[0].body_rank),
    "a heading match must outrank a body match"
  );
});

test("partial-question matches survive, whole-question matches outrank them", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  const whole = await seedSection(pool, {
    heading: "Refunds on annual subscriptions",
    headingPath: ["Billing"],
    path: "billing/annual.md",
    content: "We refund annual subscriptions pro rata."
  });
  const partial = await seedSection(pool, {
    heading: "Refunds",
    headingPath: ["Billing"],
    path: "billing/refunds.md",
    content: "Refunds are issued to the original payment method."
  });
  // node:test runs t.after hooks in registration order, so the delete (which
  // needs a live pool) must be registered before the pool.end() hook. documents
  // has no ON DELETE CASCADE from repositories (see seedSection above), so
  // documents (and their cascading sections) must be deleted before repositories.
  t.after(async () => {
    await pool.query("DELETE FROM documents WHERE repository_id = ANY($1)", [
      [whole.repositoryId, partial.repositoryId]
    ]);
    await pool.query("DELETE FROM repositories WHERE id = ANY($1)", [[whole.repositoryId, partial.repositoryId]]);
  });
  t.after(() => pool.end());

  const store = new PostgresKnowledgeStore(pool);
  const hits = await store.searchByKeyword("how do we handle refunds for annual subscriptions?", 10, [
    whole.repositoryId,
    partial.repositoryId
  ]);

  const ids = hits.map((hit) => hit.id);
  assert.ok(ids.includes(partial.sectionId), "a section matching only some terms must still be returned");
  assert.equal(ids[0], whole.sectionId, "the section matching the whole question must rank first");
  for (const hit of hits) {
    assert.ok(hit.relevance > 0 && hit.relevance <= 1, `relevance ${hit.relevance} must stay in (0,1]`);
  }
});

test("a stopword-only question returns nothing", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const store = new PostgresKnowledgeStore(pool);
  assert.deepEqual(await store.searchByKeyword("the and of", 10), []);
});
