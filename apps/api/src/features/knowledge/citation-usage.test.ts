import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocumentSection, KnowledgeDocument, SectionCitationUsage } from "@magpie/core";
import { buildCitationUsageReport, type CitationUsageOptions } from "./citation-usage.js";

function document(path: string, title: string, repositoryId = "kb"): KnowledgeDocument {
  return {
    id: `${repositoryId}:${path}`,
    repositoryId,
    path,
    metadata: { title, status: "active", tags: [], relatedDocs: [] },
    content: "# " + title
  };
}

function section(documentPath: string, anchor: string, ordinal: number, repositoryId = "kb"): DocumentSection {
  return {
    id: `${repositoryId}:${documentPath}:${ordinal}`,
    documentId: `${repositoryId}:${documentPath}`,
    path: documentPath,
    heading: anchor,
    headingPath: [anchor],
    anchor,
    content: "body",
    ordinal
  };
}

function usage(
  documentPath: string,
  anchor: string,
  citationCount: number,
  lastCitedAt: string,
  repositoryId = "kb"
): SectionCitationUsage {
  return {
    documentId: `${repositoryId}:${documentPath}`,
    anchor,
    path: documentPath,
    heading: anchor,
    citationCount,
    firstCitedAt: "2026-01-01T00:00:00.000Z",
    lastCitedAt
  };
}

const options = (overrides: Partial<CitationUsageOptions> = {}): CitationUsageOptions => ({
  group: "section",
  sort: "least",
  limit: 50,
  offset: 0,
  ...overrides
});

test("never-cited sections are reported with a zero count, ordered first", () => {
  const report = buildCitationUsageReport(
    {
      documents: [document("guide.md", "Guide")],
      sections: [section("guide.md", "setup", 0), section("guide.md", "faq", 1)],
      usage: [usage("guide.md", "setup", 3, "2026-06-01T00:00:00.000Z")]
    },
    options()
  );

  assert.deepEqual(
    report.rows.map((row) => [row.anchor, row.citationCount, row.indexed]),
    [
      ["faq", 0, true],
      ["setup", 3, true]
    ]
  );
  assert.deepEqual(report.summary, {
    indexedSections: 2,
    citedSections: 1,
    uncitedSections: 1,
    indexedDocuments: 1,
    citedDocuments: 1,
    uncitedDocuments: 0,
    totalCitations: 3,
    unindexedUsageRows: 0
  });
});

test("least-used ordering breaks count ties on the oldest last citation", () => {
  const report = buildCitationUsageReport(
    {
      documents: [document("guide.md", "Guide")],
      sections: [section("guide.md", "recent", 0), section("guide.md", "stale", 1)],
      usage: [
        usage("guide.md", "recent", 2, "2026-07-01T00:00:00.000Z"),
        usage("guide.md", "stale", 2, "2026-02-01T00:00:00.000Z")
      ]
    },
    options()
  );

  assert.deepEqual(
    report.rows.map((row) => row.anchor),
    ["stale", "recent"]
  );
});

test("usage for a section that is no longer indexed is kept and flagged", () => {
  // A heading rename (or a deleted document) leaves a counter with no live
  // section. Dropping it would hide "we removed something people were using".
  const report = buildCitationUsageReport(
    {
      documents: [document("guide.md", "Guide")],
      sections: [section("guide.md", "setup", 0)],
      usage: [usage("guide.md", "old-heading", 9, "2026-05-01T00:00:00.000Z")]
    },
    options({ sort: "most" })
  );

  assert.deepEqual(
    report.rows.map((row) => [row.anchor, row.citationCount, row.indexed]),
    [
      ["old-heading", 9, false],
      ["setup", 0, true]
    ]
  );
  assert.equal(report.summary.unindexedUsageRows, 1);
  // The stale counter still belongs to a live document, so that document counts
  // as cited even though none of its current sections has been.
  assert.equal(report.summary.citedDocuments, 1);
  assert.equal(report.summary.citedSections, 0);
});

test("document grouping sums section counts and reports cited/total sections", () => {
  const report = buildCitationUsageReport(
    {
      documents: [document("busy.md", "Busy"), document("cold.md", "Cold")],
      sections: [
        section("busy.md", "a", 0),
        section("busy.md", "b", 1),
        section("cold.md", "c", 0),
        section("cold.md", "d", 1)
      ],
      usage: [
        usage("busy.md", "a", 4, "2026-06-01T00:00:00.000Z"),
        usage("busy.md", "b", 1, "2026-06-02T00:00:00.000Z")
      ]
    },
    options({ group: "document" })
  );

  assert.deepEqual(
    report.rows.map((row) => [row.path, row.citationCount, row.citedSectionCount, row.sectionCount]),
    [
      ["cold.md", 0, 0, 2],
      ["busy.md", 5, 2, 2]
    ]
  );
  assert.equal(report.rows[1].lastCitedAt, "2026-06-02T00:00:00.000Z");
  assert.deepEqual(report.summary.uncitedDocuments, 1);
});

test("repositoryId narrows the report to one destination's documents", () => {
  const report = buildCitationUsageReport(
    {
      documents: [document("guide.md", "Guide", "kb"), document("other.md", "Other", "kb2")],
      sections: [section("guide.md", "setup", 0, "kb"), section("other.md", "setup", 0, "kb2")],
      usage: [
        usage("guide.md", "setup", 1, "2026-06-01T00:00:00.000Z", "kb"),
        usage("other.md", "setup", 7, "2026-06-01T00:00:00.000Z", "kb2")
      ]
    },
    options({ repositoryId: "kb2" })
  );

  assert.deepEqual(
    report.rows.map((row) => [row.documentId, row.citationCount]),
    [["kb2:other.md", 7]]
  );
  assert.equal(report.summary.indexedDocuments, 1);
  assert.equal(report.summary.totalCitations, 7);
});

test("paginates over the full ranked set and reports the unpaginated total", () => {
  const sections = Array.from({ length: 5 }, (_, index) => section("guide.md", `s${index}`, index));
  const report = buildCitationUsageReport(
    { documents: [document("guide.md", "Guide")], sections, usage: [] },
    options({ limit: 2, offset: 2 })
  );

  assert.equal(report.total, 5);
  assert.deepEqual(
    report.rows.map((row) => row.anchor),
    ["s2", "s3"]
  );
});

test("recent ordering puts the most recently cited first and never-cited last", () => {
  const report = buildCitationUsageReport(
    {
      documents: [document("guide.md", "Guide")],
      sections: [section("guide.md", "a", 0), section("guide.md", "b", 1), section("guide.md", "c", 2)],
      usage: [
        usage("guide.md", "a", 1, "2026-03-01T00:00:00.000Z"),
        usage("guide.md", "c", 1, "2026-07-01T00:00:00.000Z")
      ]
    },
    options({ sort: "recent" })
  );

  assert.deepEqual(
    report.rows.map((row) => row.anchor),
    ["c", "a", "b"]
  );
});
