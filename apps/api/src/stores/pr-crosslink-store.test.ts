import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryPrCrosslinkStore, pairKey } from "./pr-crosslink-store.js";

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

test("existingPairs returns the linked pairs among a candidate set as order-independent keys", async () => {
  const store = new InMemoryPrCrosslinkStore();
  await store.record({ proposalA: "p2", proposalB: "p1", targets: ["kb/a.md"] });
  await store.record({ proposalA: "p3", proposalB: "p4", targets: ["kb/b.md"] });

  const pairs = await store.existingPairs(["p1", "p2", "p3"]);
  // p1/p2 is in the set (order-independent); p3/p4 is excluded because p4 is not
  // a candidate; an unlinked pair is absent.
  assert.equal(pairs.has(pairKey("p1", "p2")), true);
  assert.equal(pairs.has(pairKey("p2", "p1")), true);
  assert.equal(pairs.has(pairKey("p3", "p4")), false);
  assert.equal(pairs.has(pairKey("p1", "p3")), false);
  assert.equal(pairs.size, 1);

  // An empty candidate set is a no-op.
  assert.equal((await store.existingPairs([])).size, 0);
});
