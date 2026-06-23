import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryPrCrosslinkStore } from "./pr-crosslink-store.js";

test("a recorded pair is found regardless of order", async () => {
  const store = new InMemoryPrCrosslinkStore();
  assert.equal(await store.has("p1", "p2"), false);
  await store.record({ proposalA: "p2", proposalB: "p1", targets: ["kb/a.md"] });
  assert.equal(await store.has("p1", "p2"), true);
  assert.equal(await store.has("p2", "p1"), true);
});

test("recording the same pair twice does not duplicate", async () => {
  const store = new InMemoryPrCrosslinkStore();
  await store.record({ proposalA: "p1", proposalB: "p2", targets: ["kb/a.md"] });
  await store.record({ proposalA: "p2", proposalB: "p1", targets: ["kb/a.md"] });
  assert.equal((await store.list(10)).length, 1);
});
