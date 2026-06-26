import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPatrolStore } from "./patrol-store.js";

test("stampChecked upserts last-checked timestamps the cursor reads back", async () => {
  const store = new InMemoryPatrolStore();
  await store.stampChecked(undefined, ["a.md", "b.md"]);
  const cursor = await store.listCursor(undefined);
  assert.deepEqual(cursor.map((entry) => entry.docPath).sort(), ["a.md", "b.md"]);
  assert.ok(cursor.every((entry) => typeof entry.lastCheckedAt === "string"));

  const first = (await store.listCursor(undefined)).find((entry) => entry.docPath === "a.md")!.lastCheckedAt;
  await store.stampChecked(undefined, ["a.md"]);
  const second = (await store.listCursor(undefined)).find((entry) => entry.docPath === "a.md")!.lastCheckedAt;
  assert.ok(second >= first, "re-stamping advances (or holds) the timestamp, never duplicates the row");
  assert.equal((await store.listCursor(undefined)).filter((entry) => entry.docPath === "a.md").length, 1);
});

test("the cursor is scoped per flow; the default flow is its own set", async () => {
  const store = new InMemoryPatrolStore();
  await store.stampChecked(undefined, ["a.md"]);
  await store.stampChecked("billing", ["b.md"]);
  assert.deepEqual((await store.listCursor(undefined)).map((e) => e.docPath), ["a.md"]);
  assert.deepEqual((await store.listCursor("billing")).map((e) => e.docPath), ["b.md"]);
});


test("cursor kinds keep fix and improve patrol freshness separate", async () => {
  const store = new InMemoryPatrolStore();
  await store.stampChecked("billing", ["fix.md"]);
  await store.stampChecked("billing", ["improve.md"], "improve");

  assert.deepEqual((await store.listCursor("billing")).map((e) => e.docPath), ["fix.md"]);
  assert.deepEqual((await store.listCursor("billing", "improve")).map((e) => e.docPath), ["improve.md"]);
  assert.deepEqual(await store.listCursor(undefined, "improve"), []);
});

test("reset clears the cursor", async () => {
  const store = new InMemoryPatrolStore();
  await store.stampChecked(undefined, ["a.md"]);
  await store.reset();
  assert.deepEqual(await store.listCursor(undefined), []);
});
