import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceDataContext } from "@magpie/core";
import { InMemorySourceCorpusStore } from "./source-corpus-store.js";

const CORPUS: SourceDataContext[] = [
  { sourceId: "s1", sourceName: "Billing", kind: "git", path: "refunds.ts", content: "partial refunds are supported" }
];

test("save then get round-trips the corpus by hash", async () => {
  const store = new InMemorySourceCorpusStore();
  await store.save("hash-a", CORPUS);
  assert.deepEqual(await store.get("hash-a"), CORPUS);
});

test("get returns undefined for an unknown hash", async () => {
  const store = new InMemorySourceCorpusStore();
  assert.equal(await store.get("never-saved"), undefined);
});

test("stored snapshots are decoupled from the caller's array (no shared mutation)", async () => {
  const store = new InMemorySourceCorpusStore();
  const input: SourceDataContext[] = [{ sourceId: "s1", sourceName: "S", kind: "git", content: "x" }];
  await store.save("hash-b", input);
  input.push({ sourceId: "s2", sourceName: "S2", kind: "git", content: "y" });
  const got = await store.get("hash-b");
  assert.equal(got?.length, 1, "a later mutation of the input does not leak into the stored snapshot");
});
