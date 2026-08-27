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

// The filter + aggregate SQL behind GET /api/knowledge/changes (rollout step 3).
// The in-memory store mirrors these semantics for the unit tests; what only a real
// database can check is that the WHERE builder, the = ANY flow scope and the
// GROUPING SETS summary actually describe the same window.
test("knowledge_changes filters, and summarizes the filtered window", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresKnowledgeChangeStore(pool);
  t.after(async () => {
    await store.reset();
    await pool.end();
  });
  await store.reset();

  await store.record([
    entry({ commitSha: "c1", flowId: "billing", documentId: "kb:rates.md", cause: "gap" }),
    entry({
      commitSha: "c2",
      flowId: "billing",
      documentId: "kb:rates.md",
      anchor: "limits",
      kind: "section_added",
      cause: "source_sync",
      sourceId: "product-repo"
    }),
    entry({ commitSha: "c3", flowId: "support", documentId: "kb:faq.md", cause: "patrol" })
  ]);

  const shas = async (filters: Parameters<PostgresKnowledgeChangeStore["list"]>[0]) =>
    (await store.list(filters)).map((change) => change.commitSha).sort();

  assert.deepEqual(await shas({ flowIds: ["billing"], limit: 10, offset: 0 }), ["c1", "c2"]);
  assert.deepEqual(await shas({ flowIds: ["billing", "support"], limit: 10, offset: 0 }), ["c1", "c2", "c3"]);
  assert.deepEqual(await shas({ documentId: "kb:faq.md", limit: 10, offset: 0 }), ["c3"]);
  assert.deepEqual(await shas({ sourceId: "product-repo", limit: 10, offset: 0 }), ["c2"]);
  assert.deepEqual(await shas({ cause: "patrol", limit: 10, offset: 0 }), ["c3"]);
  assert.deepEqual(await shas({ kind: "section_added", limit: 10, offset: 0 }), ["c2"]);
  // Filters compose as an AND: each half matches something, the pair matches nothing.
  assert.deepEqual(await shas({ flowIds: ["support"], cause: "gap", limit: 10, offset: 0 }), []);

  const all = await store.summarize({});
  assert.equal(all.total, 3);
  assert.equal(all.documentsTouched, 2);
  assert.equal(all.byKind.section_changed, 2);
  assert.equal(all.byKind.section_added, 1);
  assert.equal(all.byKind.document_removed, 0, "every kind is keyed, zeros included");
  assert.equal(all.byCause.gap, 1);
  assert.equal(all.byCause.source_sync, 1);
  assert.equal(all.byCause.patrol, 1);

  const billing = await store.summarize({ flowIds: ["billing"] });
  assert.equal(billing.total, 2, "the summary counts the filtered window, not the table");
  assert.equal(billing.documentsTouched, 1, "both billing entries touch the same document");
  assert.equal(billing.byCause.patrol, 0);
});

test("knowledge_changes filters on a half-open [since, until) window", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresKnowledgeChangeStore(pool);
  t.after(async () => {
    await store.reset();
    await pool.end();
  });
  await store.reset();

  await store.record([entry({ commitSha: "old" })]);
  await store.record([entry({ commitSha: "new" })]);
  const boundary = (await store.list({ limit: 1, offset: 0 }))[0]!.changedAt;

  assert.deepEqual(
    (await store.list({ since: boundary, limit: 10, offset: 0 })).map((change) => change.commitSha),
    ["new"],
    "since is inclusive"
  );
  assert.deepEqual(
    (await store.list({ until: boundary, limit: 10, offset: 0 })).map((change) => change.commitSha),
    ["old"],
    "until is exclusive, so a boundary belongs to exactly one window"
  );
});

test("knowledge_changes reports the log's start instant per scope", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresKnowledgeChangeStore(pool);
  t.after(async () => {
    await store.reset();
    await pool.end();
  });
  await store.reset();

  await store.record([entry({ commitSha: "c1", flowId: "billing" })]);
  await store.record([entry({ commitSha: "c2", flowId: "support" })]);
  const [newest, oldest] = await store.list({ limit: 10, offset: 0 });

  assert.equal(await store.firstChangedAt({}), oldest!.changedAt);
  assert.equal(await store.firstChangedAt({ flowIds: ["support"] }), newest!.changedAt);
  // The point of the read: a scope with no entries is knowably empty, so a caller
  // can say "nothing recorded yet" instead of "nothing changed".
  assert.equal(await store.firstChangedAt({ flowIds: ["unknown"] }), undefined);
});

test(
  "knowledge_changes returns the newest entry per section in one batched read",
  { skip: !runIntegration },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const store = new PostgresKnowledgeChangeStore(pool);
    t.after(async () => {
      await store.reset();
      await pool.end();
    });
    await store.reset();

    // The answer-path read (KC-6). DISTINCT ON over the unnested (document_id,
    // anchor) pairs is the part the in-memory store can only mirror.
    await store.record([entry({ commitSha: "c1", kind: "section_added", summary: "first draft" })]);
    await store.record([entry({ commitSha: "c2", kind: "section_changed", summary: "rate tier update" })]);
    await store.record([entry({ commitSha: "c3", anchor: "limits", heading: "Limits" })]);
    await store.record([entry({ commitSha: "c4", kind: "document_added", anchor: undefined, heading: undefined })]);

    const latest = await store.latestForSections([
      { documentId: "kb:guide.md", anchor: "rate-tiers" },
      { documentId: "kb:guide.md", anchor: "limits" },
      { documentId: "kb:guide.md", anchor: "never-changed" }
    ]);

    assert.deepEqual(
      latest.map((change) => [change.anchor, change.commitSha]).sort(),
      [
        ["limits", "c3"],
        ["rate-tiers", "c2"]
      ],
      "newest per anchor; a section with no history is simply absent, and the document-level entry never matches"
    );
    assert.equal(latest.find((change) => change.anchor === "rate-tiers")?.summary, "rate tier update");
    assert.deepEqual(await store.latestForSections([]), [], "an empty batch is not a query");
  }
);
