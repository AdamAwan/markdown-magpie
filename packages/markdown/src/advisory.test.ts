import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findAdvisoryHeadings } from "./index.js";

describe("findAdvisoryHeadings", () => {
  it("flags the canonical advisory headings at any level", () => {
    const markdown = [
      "# Audit logging",
      "## How events are recorded",
      "## Recommendations",
      "### Next steps",
      "#### Phase 1 roadmap",
      "## Action items"
    ].join("\n");
    assert.deepEqual(findAdvisoryHeadings(markdown), [
      "Recommendations",
      "Next steps",
      "Phase 1 roadmap",
      "Action items"
    ]);
  });

  it("matches whole words only — descriptive headings pass", () => {
    const markdown = [
      "## Overview",
      "## How ingestion works",
      "## Stepwise processing", // "step" is a substring, not the phrase "next steps"
      "## Recommendation engine architecture" // contains the word — flagged (a reviewer decides)
    ].join("\n");
    assert.deepEqual(findAdvisoryHeadings(markdown), ["Recommendation engine architecture"]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const markdown = ["## Usage", "```md", "## Recommendations", "```", "body"].join("\n");
    assert.deepEqual(findAdvisoryHeadings(markdown), []);
  });

  it("deduplicates repeated headings and preserves first-seen order", () => {
    const markdown = ["## Next steps", "text", "## Roadmap", "text", "## Next steps"].join("\n");
    assert.deepEqual(findAdvisoryHeadings(markdown), ["Next steps", "Roadmap"]);
  });

  it("returns empty for a document with no headings", () => {
    assert.deepEqual(findAdvisoryHeadings("just a paragraph"), []);
  });
});
