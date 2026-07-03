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
});

describe("citesMergedDoc", () => {
  it("is true only when a citation path is among the target paths", () => {
    assert.equal(citesMergedDoc([cite("docs/guide.md")], paths), true);
    assert.equal(citesMergedDoc([cite("docs/other.md")], paths), false);
    assert.equal(citesMergedDoc([], paths), false);
  });
});
