import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedTargets } from "./reconcile-gate.js";

test("sharedTargets returns the intersection in a's order", () => {
  assert.deepEqual(
    sharedTargets(["kb/refunds.md", "kb/credits.md"], ["kb/credits.md", "kb/refunds.md"]),
    ["kb/refunds.md", "kb/credits.md"]
  );
});

test("sharedTargets is empty when file-sets are disjoint", () => {
  assert.deepEqual(sharedTargets(["kb/a.md"], ["kb/b.md"]), []);
});

test("sharedTargets de-duplicates and ignores empty sets", () => {
  assert.deepEqual(sharedTargets(["kb/a.md", "kb/a.md"], ["kb/a.md"]), ["kb/a.md"]);
  assert.deepEqual(sharedTargets([], ["kb/a.md"]), []);
});
