import assert from "node:assert/strict";
import { test } from "node:test";
import { MAINTENANCE_LENSES, type ChangeIntent } from "./intent.js";

test("the six maintenance lenses are declared", () => {
  assert.deepEqual([...MAINTENANCE_LENSES].sort(), ["complete", "dedupe", "gap", "source-sync", "split", "verify"]);
});

test("a ChangeIntent carries lens, targets, evidence and rationale", () => {
  const intent: ChangeIntent = {
    lens: "gap",
    targets: [],
    evidence: ["users keep asking how refunds settle"],
    rationale: "recurring unanswered question"
  };
  assert.equal(intent.lens, "gap");
  assert.deepEqual(intent.targets, []);
});
