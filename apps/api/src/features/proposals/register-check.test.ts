import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advisoryNote, collectAdvisoryHeadings, flagAdvisoryDraft } from "./register-check.js";
import type { ProposalInput } from "../../stores/proposal-store.js";

const baseInput: ProposalInput = {
  title: "T",
  targetPath: "kb/t.md",
  markdown: "# T\n\nbody",
  rationale: "grounded",
  evidence: []
};

describe("collectAdvisoryHeadings", () => {
  it("scans the primary markdown when there is no changeset", () => {
    assert.deepEqual(
      collectAdvisoryHeadings("# Doc\n\n## Recommendations\n\n## Usage"),
      ["Recommendations"]
    );
  });

  it("scans every changeset write and skips deletes, deduplicating across files", () => {
    const headings = collectAdvisoryHeadings("# unused primary", [
      { path: "kb/a.md", content: "# A\n\n## Next steps" },
      { path: "kb/b.md", content: "# B\n\n## Next steps\n\n## Roadmap" },
      { path: "kb/c.md", delete: true }
    ]);
    assert.deepEqual(headings, ["Next steps", "Roadmap"]);
  });
});

describe("flagAdvisoryDraft", () => {
  it("returns the input unchanged when no advisory heading is present", () => {
    const flagged = flagAdvisoryDraft(baseInput, { jobType: "draft_seed_document" });
    assert.equal(flagged, baseInput);
  });

  it("appends the reviewer note to the rationale and preserves every other field", () => {
    const advisory: ProposalInput = { ...baseInput, markdown: "# T\n\n## Recommendations\n\ndo things" };
    const flagged = flagAdvisoryDraft(advisory, { jobId: "job-1", jobType: "draft_seed_document" });
    assert.equal(flagged.markdown, advisory.markdown, "the document body is never edited");
    assert.ok(flagged.rationale.startsWith("grounded"), "the original rationale is preserved");
    assert.ok(flagged.rationale.includes(advisoryNote(["Recommendations"])));
    assert.equal(flagged.targetPath, advisory.targetPath);
  });
});
