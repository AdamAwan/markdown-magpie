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

  it("flags a setext H1 heading (=== underline)", () => {
    const markdown = "Recommendations\n================\nbody";
    assert.deepEqual(findAdvisoryHeadings(markdown), ["Recommendations"]);
  });

  it("flags a setext H2 heading (--- underline)", () => {
    const markdown = ["Next steps", "---", "body"].join("\n");
    assert.deepEqual(findAdvisoryHeadings(markdown), ["Next steps"]);
  });

  it("does not treat a standalone thematic break as a setext heading", () => {
    const markdown = ["Some text", "", "---", "", "More text"].join("\n");
    assert.deepEqual(findAdvisoryHeadings(markdown), []);
  });

  it("does not turn frontmatter delimiters into headings", () => {
    const markdown = ["---", "title: Recommendations", "---", "body"].join("\n");
    assert.deepEqual(findAdvisoryHeadings(markdown), []);
  });

  it("ignores a setext-lookalike heading inside a fenced code block", () => {
    const markdown = ["## Usage", "```md", "Recommendations", "===", "```", "body"].join("\n");
    assert.deepEqual(findAdvisoryHeadings(markdown), []);
  });

  it("strips the optional closing hash sequence from a closed ATX heading", () => {
    assert.deepEqual(findAdvisoryHeadings("## Recommendations ##"), ["Recommendations"]);
  });
});
