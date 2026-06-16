import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProposalTargetPath } from "@magpie/core";

test("places the proposal under the destination's docs subpath", () => {
  assert.equal(
    resolveProposalTargetPath("docs", "How do I trim claws?"),
    "docs/how-do-i-trim-claws.md"
  );
});

test("writes to the repository root when the destination has no subpath", () => {
  assert.equal(resolveProposalTargetPath(undefined, "Cat Care"), "cat-care.md");
  assert.equal(resolveProposalTargetPath("", "Cat Care"), "cat-care.md");
});

test("normalises slashes and trims surrounding separators in the subpath", () => {
  assert.equal(
    resolveProposalTargetPath("/knowledge\\cats/", "Trimming Claws"),
    "knowledge/cats/trimming-claws.md"
  );
});

test("never adds a 'proposed/' staging prefix — the branch is the proposal", () => {
  assert.ok(!resolveProposalTargetPath("docs", "Anything").includes("proposed/"));
});

test("falls back to knowledge-gap.md when the title has no slug characters", () => {
  assert.equal(resolveProposalTargetPath("docs", "???"), "docs/knowledge-gap.md");
});

test("bounds the filename slug and drops any trailing dash", () => {
  const fileName = resolveProposalTargetPath(undefined, "a".repeat(80));
  assert.equal(fileName, `${"a".repeat(60)}.md`);
  assert.ok(!fileName.includes("-.md"));
});
