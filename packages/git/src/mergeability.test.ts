import assert from "node:assert/strict";
import { test } from "node:test";
import { toMergeability } from "./index.js";

// "dirty" is GitHub's explicit conflict marker; a boolean false corroborates it.
test("conflicting when mergeable is false or state is dirty", () => {
  assert.equal(toMergeability(false, "clean"), "conflicting");
  assert.equal(toMergeability(null, "dirty"), "conflicting");
  assert.equal(toMergeability(true, "dirty"), "conflicting");
});

test("mergeable when GitHub reports mergeable true and no conflict", () => {
  assert.equal(toMergeability(true, "clean"), "mergeable");
  assert.equal(toMergeability(true, "blocked"), "mergeable");
  assert.equal(toMergeability(true, undefined), "mergeable");
});

// GitHub computes mergeability asynchronously — an unsettled read must not trigger.
test("unknown when GitHub has not computed mergeability yet", () => {
  assert.equal(toMergeability(null, "unknown"), "unknown");
  assert.equal(toMergeability(null, undefined), "unknown");
  assert.equal(toMergeability(undefined, undefined), "unknown");
});
