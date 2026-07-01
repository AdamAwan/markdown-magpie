import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresPatrolStore } from "./postgres-patrol-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

const databaseUrl = process.env.DATABASE_URL;

test("PostgresPatrolStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, async () => {
  const store = new PostgresPatrolStore(makeTestPool(databaseUrl!));
  await store.reset();

  await store.stampChecked("billing", ["a.md", "b.md"]);
  const cursor = await store.listCursor("billing");
  assert.deepEqual(cursor.map((entry) => entry.docPath).sort(), ["a.md", "b.md"]);
  assert.deepEqual(await store.listCursor(undefined), [], "billing rows do not leak to the default flow");

  await store.stampChecked("billing", ["improve.md"], "improve");
  assert.deepEqual((await store.listCursor("billing")).map((entry) => entry.docPath).sort(), ["a.md", "b.md"]);
  assert.deepEqual((await store.listCursor("billing", "improve")).map((entry) => entry.docPath), ["improve.md"]);

  // Re-stamping a doc keeps one row (upsert), not two.
  await store.stampChecked("billing", ["a.md"]);
  assert.equal((await store.listCursor("billing")).filter((e) => e.docPath === "a.md").length, 1);

  await store.reset();
  assert.deepEqual(await store.listCursor("billing"), []);
});
