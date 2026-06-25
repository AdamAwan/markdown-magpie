import { test } from "node:test";
import assert from "node:assert/strict";
import type { Proposal } from "@magpie/core";
import { proposalChangeset, proposalTargets } from "./changeset.js";

function baseProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    title: "t",
    status: "draft",
    targetPath: "docs/a.md",
    markdown: "# A",
    evidence: [],
    createdAt: new Date(0).toISOString(),
    ...overrides
  };
}

test("single-file proposal derives a one-entry changeset from targetPath/markdown", () => {
  const proposal = baseProposal();
  assert.deepEqual(proposalChangeset(proposal), [{ path: "docs/a.md", content: "# A" }]);
  assert.deepEqual(proposalTargets(proposal), ["docs/a.md"]);
});

test("changeset proposal returns its changeset and all its paths", () => {
  const proposal = baseProposal({
    changeset: [
      { path: "docs/a.md", content: "# A merged" },
      { path: "docs/b.md", delete: true }
    ]
  });
  assert.deepEqual(proposalChangeset(proposal), [
    { path: "docs/a.md", content: "# A merged" },
    { path: "docs/b.md", delete: true }
  ]);
  assert.deepEqual(proposalTargets(proposal), ["docs/a.md", "docs/b.md"]);
});
