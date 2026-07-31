import test from "node:test";
import assert from "node:assert/strict";
import { hasConflictMarker, insertConflictMarker, stripConflictMarker } from "./conflict-marker.js";

const DOC = `# Logging

Intro.

## Retention

Logs are retained for 1 year.
`;

const SUMMARY = "Sources disagree on the log retention period: one states 1 year, another enforces 60 days.";

// The anchor is the slugified heading PATH, not the leaf heading.
const RETENTION = "logging-retention";

test("inserts the marker directly under the target heading", () => {
  const out = insertConflictMarker(DOC, { conflictId: "c1", anchor: RETENTION, summary: SUMMARY });
  assert.match(out, /## Retention\n\n<!-- magpie:conflict id=c1 -->/);
  assert.match(out, /> \*\*Unresolved source conflict\.\*\* Sources disagree/);
  assert.match(out, /<!-- \/magpie:conflict -->/);
  // Annotation is insert-only: the original prose survives untouched.
  assert.match(out, /Logs are retained for 1 year\./);
});

test("strip is an exact inverse of insert", () => {
  const args = { conflictId: "c1", anchor: RETENTION, summary: SUMMARY };
  assert.equal(stripConflictMarker(insertConflictMarker(DOC, args), "c1"), DOC);
});

test("insert is idempotent for the same conflict id", () => {
  // This is what stops annotate -> content changes -> re-verify -> re-annotate.
  const args = { conflictId: "c1", anchor: RETENTION, summary: SUMMARY };
  const once = insertConflictMarker(DOC, args);
  assert.equal(insertConflictMarker(once, args), once);
});

test("strip leaves another conflict's marker in place", () => {
  const a = insertConflictMarker(DOC, { conflictId: "a", anchor: RETENTION, summary: "sa" });
  const both = insertConflictMarker(a, { conflictId: "b", anchor: RETENTION, summary: "sb" });
  const stripped = stripConflictMarker(both, "b");
  assert.ok(hasConflictMarker(stripped, "a"));
  assert.ok(!hasConflictMarker(stripped, "b"));
});

test("an unknown anchor appends rather than dropping the marker", () => {
  // A misplaced conflict notice is recoverable; a silently discarded one is not.
  const out = insertConflictMarker(DOC, { conflictId: "c1", anchor: "no-such-section", summary: SUMMARY });
  assert.ok(hasConflictMarker(out, "c1"));
});

test("a multi-line summary cannot break out of the blockquote", () => {
  // The summary is untrusted source-derived text reaching a published document.
  const out = insertConflictMarker(DOC, {
    conflictId: "c1",
    anchor: RETENTION,
    summary: "line one\n## Injected heading"
  });
  assert.match(out, /> ## Injected heading/);
  assert.ok(!/^## Injected heading$/m.test(out));
});

test("targets the right section when headings repeat", () => {
  const doc = `# A\n\n## Notes\n\nfirst\n\n# B\n\n## Notes\n\nsecond\n`;
  const out = insertConflictMarker(doc, { conflictId: "c1", anchor: "b-notes", summary: "s" });
  const marker = out.indexOf("<!-- magpie:conflict");
  assert.ok(marker > out.indexOf("# B"), "marker should land in the second Notes section");
});

test("respects frontmatter when locating the heading", () => {
  const doc = `---\ntitle: Logging\n---\n\n# Logging\n\n## Retention\n\nLogs are retained for 1 year.\n`;
  const out = insertConflictMarker(doc, { conflictId: "c1", anchor: RETENTION, summary: SUMMARY });
  assert.match(out, /## Retention\n\n<!-- magpie:conflict id=c1 -->/);
});

test("does not treat a heading inside a fenced block as a section", () => {
  const doc = `# A\n\n\`\`\`\n## Not a heading\n\`\`\`\n\n## Real\n\nbody\n`;
  const out = insertConflictMarker(doc, { conflictId: "c1", anchor: "a-real", summary: "s" });
  assert.match(out, /## Real\n\n<!-- magpie:conflict id=c1 -->/);
});
