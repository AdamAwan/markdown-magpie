import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceDataContext } from "@magpie/core";
import { PostgresSourceCorpusStore } from "./postgres-source-corpus-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

const databaseUrl = process.env.DATABASE_URL;

const CORPUS: SourceDataContext[] = [
  { sourceId: "s1", sourceName: "Billing", kind: "git", path: "refunds.ts", content: "partial refunds are supported" }
];

test("PostgresSourceCorpusStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, async () => {
  const pool = makeTestPool(databaseUrl!);
  const store = new PostgresSourceCorpusStore(pool);
  await pool.query("DELETE FROM source_corpus_snapshot");

  // Save then resolve round-trips the corpus by hash; an unknown hash is undefined.
  await store.save("hash-a", CORPUS);
  assert.deepEqual(await store.get("hash-a"), CORPUS);
  assert.equal(await store.get("never-saved"), undefined);

  // Re-saving the same hash keeps exactly one row (content-addressed upsert).
  await store.save("hash-a", CORPUS);
  const count = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM source_corpus_snapshot WHERE hash = $1", [
    "hash-a"
  ]);
  assert.equal(count.rows[0]?.n, "1");

  // A snapshot whose last_used_at fell out of the retention window is pruned on the
  // next save (a live job's snapshot is refreshed on save, so this only reaps stale ones).
  await pool.query("UPDATE source_corpus_snapshot SET last_used_at = now() - interval '2 days' WHERE hash = $1", [
    "hash-a"
  ]);
  await store.save("hash-b", CORPUS);
  assert.equal(await store.get("hash-a"), undefined, "the stale snapshot was pruned");
  assert.deepEqual(await store.get("hash-b"), CORPUS, "the fresh snapshot survives");

  await pool.query("DELETE FROM source_corpus_snapshot");
});
