import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { PostgresKnowledgeChangeStore } from "./postgres-knowledge-change-store.js";
import type { KnowledgeChangeRecord } from "./knowledge-change-store.js";

// DB-backed tests for the change log's dedupe SQL — the partial unique index and
// the no-sha window probe are the parts the in-memory store can only mirror.
// Gated by RUN_PG_INTEGRATION so the default unit run stays database-free.
const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/markdown_magpie";

function entry(overrides: Partial<KnowledgeChangeRecord> = {}): KnowledgeChangeRecord {
  return {
    repositoryId: "kb",
    documentId: "kb:guide.md",
    path: "guide.md",
    anchor: "rate-tiers",
    heading: "Rate tiers",
    kind: "section_changed",
    commitSha: "abc123",
    cause: "external",
    ...overrides
  };
}

test("knowledge_changes dedupes a replayed transition", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresKnowledgeChangeStore(pool);
  t.after(async () => {
    await store.reset();
    await pool.end();
  });
  await store.reset();

  assert.equal(await store.record([entry()]), 1);
  assert.equal(await store.record([entry()]), 0, "the same transition at the same commit is one entry");
  // A document-level entry has a NULL anchor; NULLs are not equal under a plain
  // unique index, so the index is built over COALESCE(anchor, '').
  const removal = entry({ kind: "document_removed", anchor: undefined, heading: undefined });
  assert.equal(await store.record([removal]), 1);
  assert.equal(await store.record([removal]), 0);
  // A later commit is a genuinely new change.
  assert.equal(await store.record([entry({ commitSha: "def456" })]), 1);

  const entries = await store.list({ limit: 10, offset: 0 });
  assert.equal(entries.length, 3);
});

test("knowledge_changes dedupes an unversioned entry within the window", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresKnowledgeChangeStore(pool);
  t.after(async () => {
    await store.reset();
    await pool.end();
  });
  await store.reset();

  const unversioned = entry({ commitSha: undefined });
  assert.equal(await store.record([unversioned]), 1);
  assert.equal(await store.record([unversioned]), 0);

  // Once the window has passed, the same change is recordable again — otherwise
  // a destination with no git context would log a section's first edit and never
  // its second.
  await pool.query("UPDATE knowledge_changes SET changed_at = now() - interval '1 hour'");
  assert.equal(await store.record([unversioned]), 1);
  assert.equal((await store.list({ limit: 10, offset: 0 })).length, 2);
});

test("knowledge_changes round-trips every attribution field", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresKnowledgeChangeStore(pool);
  t.after(async () => {
    await store.reset();
    await pool.end();
  });
  await store.reset();

  await store.record([
    entry({
      cause: "source_sync",
      proposalId: "proposal-1",
      jobId: "job-1",
      sourceId: "product-repo",
      sourceFromSha: "a1b2f3",
      sourceToSha: "c3d4e5",
      summary: "Update billing rates",
      flowId: "billing-flow"
    })
  ]);

  const [stored] = await store.list({ limit: 10, offset: 0 });
  assert.equal(stored.cause, "source_sync");
  assert.equal(stored.proposalId, "proposal-1");
  assert.equal(stored.jobId, "job-1");
  assert.equal(stored.sourceId, "product-repo");
  assert.equal(stored.sourceFromSha, "a1b2f3");
  assert.equal(stored.sourceToSha, "c3d4e5");
  assert.equal(stored.summary, "Update billing rates");
  assert.equal(stored.flowId, "billing-flow");
  assert.equal(stored.anchor, "rate-tiers");
});
