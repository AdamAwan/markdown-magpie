import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";

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
