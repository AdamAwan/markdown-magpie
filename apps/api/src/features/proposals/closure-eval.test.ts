import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Citation, Proposal } from "@magpie/core";
import { citesMergedDoc, evaluateClosure, proposalTargetPaths } from "./closure-eval.js";

function cite(path: string): Citation {
  return { documentId: "d", sectionId: "s", path, heading: "h", anchor: "a", excerpt: "e", relevance: 0.9 };
}

const paths = new Set(["docs/guide.md"]);

describe("evaluateClosure", () => {
  it("closes when confident and cites the merged doc", () => {
    assert.equal(evaluateClosure({ confidence: "high", citations: [cite("docs/guide.md")] }, paths), "closed");
    assert.equal(evaluateClosure({ confidence: "medium", citations: [cite("docs/guide.md")] }, paths), "closed");
  });

  it("stays open when confident but cites a different doc", () => {
    assert.equal(evaluateClosure({ confidence: "high", citations: [cite("docs/other.md")] }, paths), "still_open");
  });

  it("stays open when it cites the doc but is not confident", () => {
    assert.equal(evaluateClosure({ confidence: "low", citations: [cite("docs/guide.md")] }, paths), "still_open");
    assert.equal(evaluateClosure({ confidence: "unknown", citations: [cite("docs/guide.md")] }, paths), "still_open");
  });

  it("stays open when there is no answer (re-ask timed out)", () => {
    assert.equal(evaluateClosure(undefined, paths), "still_open");
  });

  it("stays open when there are no citations at all", () => {
    assert.equal(evaluateClosure({ confidence: "high", citations: [] }, paths), "still_open");
  });
});

describe("proposalTargetPaths", () => {
  it("includes targetPath and changeset writes, excluding deletes and content-less entries", () => {
    const proposal = {
      targetPath: "docs/guide.md",
      changeset: [
        { path: "docs/added.md", content: "x" },
        { path: "docs/removed.md", delete: true },
        { path: "docs/noop.md" }
      ]
    } as Proposal;
    const result = proposalTargetPaths(proposal);
    assert.ok(result.has("docs/guide.md"));
    assert.ok(result.has("docs/added.md"));
    assert.ok(!result.has("docs/removed.md"));
    assert.ok(!result.has("docs/noop.md"));
  });

  it("leaves paths untouched when no subpath is configured", () => {
    const proposal = { targetPath: "docs/guide.md" } as Proposal;
    assert.deepEqual([...proposalTargetPaths(proposal, undefined)], ["docs/guide.md"]);
    assert.deepEqual([...proposalTargetPaths(proposal, "")], ["docs/guide.md"]);
  });

  it("strips a configured destination subpath from targetPath and changeset writes", () => {
    // The proposal's targetPath/changeset are destination-root-relative and
    // INCLUDE the subpath (resolveProposalTargetPath prefixes it); citations of
    // the merged file are indexed-subtree-relative with the subpath stripped.
    const proposal = {
      targetPath: "kb/configure-x.md",
      changeset: [
        { path: "kb/added.md", content: "x" },
        { path: "kb/removed.md", delete: true }
      ]
    } as Proposal;
    const result = proposalTargetPaths(proposal, "kb");
    assert.ok(result.has("configure-x.md"));
    assert.ok(result.has("added.md"));
    assert.ok(!result.has("kb/configure-x.md"));
    assert.ok(!result.has("removed.md"));
  });

  it("normalizes a subpath with surrounding slashes and handles nesting", () => {
    const proposal = { targetPath: "kb/nested/configure-x.md" } as Proposal;
    assert.deepEqual([...proposalTargetPaths(proposal, "/kb/nested/")], ["configure-x.md"]);
    assert.deepEqual([...proposalTargetPaths(proposal, "kb")], ["nested/configure-x.md"]);
  });

  it("leaves a path that does not sit under the subpath unstripped", () => {
    const proposal = { targetPath: "other/guide.md" } as Proposal;
    assert.deepEqual([...proposalTargetPaths(proposal, "kb")], ["other/guide.md"]);
  });
});

describe("evaluateClosure with a subpath destination", () => {
  it("closes when a subtree-relative citation matches the subpath-stripped target path", () => {
    const proposal = { targetPath: "kb/configure-x.md" } as Proposal;
    const targetPaths = proposalTargetPaths(proposal, "kb");
    // The re-ask cites the merged file the way retrieval sees it: subpath stripped.
    assert.equal(
      evaluateClosure({ confidence: "high", citations: [cite("configure-x.md")] }, targetPaths),
      "closed"
    );
    // Regression guard: before the fix, targetPaths held "kb/configure-x.md",
    // which no citation could ever match, so verification returned still_open forever.
    assert.equal(citesMergedDoc([cite("configure-x.md")], targetPaths), true);
  });
});

describe("citesMergedDoc", () => {
  it("is true only when a citation path is among the target paths", () => {
    assert.equal(citesMergedDoc([cite("docs/guide.md")], paths), true);
    assert.equal(citesMergedDoc([cite("docs/other.md")], paths), false);
    assert.equal(citesMergedDoc([], paths), false);
  });
});
