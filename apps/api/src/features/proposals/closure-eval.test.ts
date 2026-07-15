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
    assert.deepEqual(evaluateClosure({ confidence: "high", citations: [cite("docs/guide.md")] }, paths), {
      verdict: "closed",
      cited: true
    });
    assert.deepEqual(evaluateClosure({ confidence: "medium", citations: [cite("docs/guide.md")] }, paths), {
      verdict: "closed",
      cited: true
    });
  });

  it("stays open when confident but cites a different doc", () => {
    assert.deepEqual(evaluateClosure({ confidence: "high", citations: [cite("docs/other.md")] }, paths), {
      verdict: "still_open",
      cited: false
    });
  });

  it("stays open when it cites the doc but is not confident", () => {
    assert.deepEqual(evaluateClosure({ confidence: "low", citations: [cite("docs/guide.md")] }, paths), {
      verdict: "still_open",
      cited: true
    });
    assert.deepEqual(evaluateClosure({ confidence: "unknown", citations: [cite("docs/guide.md")] }, paths), {
      verdict: "still_open",
      cited: true
    });
  });

  it("stays open when there is no answer (re-ask timed out)", () => {
    assert.deepEqual(evaluateClosure(undefined, paths), { verdict: "still_open", cited: false });
  });

  it("stays open when there are no citations at all", () => {
    assert.deepEqual(evaluateClosure({ confidence: "high", citations: [] }, paths), {
      verdict: "still_open",
      cited: false
    });
  });

  it("stays open when a confident, citing answer still declares a whole-question gap", () => {
    // A substantive partial answer ships at medium while flagging isKnowledgeGap,
    // so confidence alone no longer proves the question was answered gap-free —
    // an 'auto' gap on the re-ask blocks closure explicitly.
    assert.deepEqual(
      evaluateClosure(
        { confidence: "medium", citations: [cite("docs/guide.md")], gaps: [{ source: "auto" }] },
        paths
      ),
      { verdict: "still_open", cited: true }
    );
  });

  it("lets followup gaps ride along without blocking closure", () => {
    // Followup gaps accompany confident answers by design (supporting material a
    // search came back empty for) and never blocked closure before either.
    assert.deepEqual(
      evaluateClosure(
        { confidence: "high", citations: [cite("docs/guide.md")], gaps: [{ source: "followup" }] },
        paths
      ),
      { verdict: "closed", cited: true }
    );
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
    assert.deepEqual(
      evaluateClosure({ confidence: "high", citations: [cite("configure-x.md")] }, targetPaths),
      { verdict: "closed", cited: true }
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
