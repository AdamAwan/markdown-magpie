import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPatrolBatch } from "./patrol-cursor.js";

// A deterministic rng that walks a fixed sequence of [0,1) values, so the random
// (explore) share is reproducible in tests.
function seededRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

test("returns the whole universe when it is no larger than the batch", () => {
  const selected = selectPatrolBatch(["a.md", "b.md"], new Map(), { batchSize: 10, randomCount: 2 });
  assert.deepEqual([...selected].sort(), ["a.md", "b.md"]);
});

test("never-checked documents are selected before checked ones, ties by path", () => {
  const universe = ["c.md", "a.md", "b.md", "d.md"];
  const checkedAt = new Map([
    ["a.md", "2026-06-24T10:00:00.000Z"],
    ["b.md", "2026-06-24T09:00:00.000Z"]
  ]);
  // batchSize 2, randomCount 0 → pure oldest: the two never-checked (c,d) first, by path.
  const selected = selectPatrolBatch(universe, checkedAt, { batchSize: 2, randomCount: 0 });
  assert.deepEqual(selected, ["c.md", "d.md"]);
});

test("older checked timestamps sort before newer ones", () => {
  const universe = ["a.md", "b.md", "c.md"];
  const checkedAt = new Map([
    ["a.md", "2026-06-24T12:00:00.000Z"],
    ["b.md", "2026-06-24T08:00:00.000Z"],
    ["c.md", "2026-06-24T10:00:00.000Z"]
  ]);
  const selected = selectPatrolBatch(universe, checkedAt, { batchSize: 2, randomCount: 0 });
  assert.deepEqual(selected, ["b.md", "c.md"]); // 08:00 then 10:00
});

test("the random share is drawn from the non-exploit remainder", () => {
  const universe = ["a.md", "b.md", "c.md", "d.md", "e.md"]; // all never-checked → sorted by path
  // batchSize 3, randomCount 1 → exploit = a,b; explore picks 1 from [c,d,e].
  // rng 0 → first remaining element = c.md.
  const selected = selectPatrolBatch(universe, new Map(), {
    batchSize: 3,
    randomCount: 1,
    rng: seededRng([0])
  });
  assert.deepEqual(selected, ["a.md", "b.md", "c.md"]);
});

test("returns an empty batch for an empty universe or non-positive batch size", () => {
  assert.deepEqual(selectPatrolBatch([], new Map(), { batchSize: 5, randomCount: 1 }), []);
  assert.deepEqual(selectPatrolBatch(["a.md"], new Map(), { batchSize: 0, randomCount: 0 }), []);
});
