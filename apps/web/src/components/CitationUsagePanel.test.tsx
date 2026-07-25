import assert from "node:assert/strict";
import test from "node:test";
import type { CitationUsageResponse } from "../lib/types";
import { renderMarkup } from "../test/render";
import { CitationUsageView } from "./CitationUsagePanel";

const noop = () => {};

function view(data: CitationUsageResponse | undefined, group: "section" | "document" = "document") {
  return renderMarkup(
    <CitationUsageView
      data={data}
      error={undefined}
      group={group}
      loading={false}
      onGroupChange={noop}
      onSortChange={noop}
      sort="least"
    />
  );
}

const documentReport: CitationUsageResponse = {
  summary: {
    indexedSections: 6,
    citedSections: 2,
    uncitedSections: 4,
    indexedDocuments: 2,
    citedDocuments: 1,
    uncitedDocuments: 1,
    totalCitations: 7,
    unindexedUsageRows: 0
  },
  rows: [
    {
      key: "kb:cold.md",
      documentId: "kb:cold.md",
      path: "cold.md",
      label: "Cold document",
      citationCount: 0,
      indexed: true,
      citedSectionCount: 0,
      sectionCount: 3
    },
    {
      key: "kb:busy.md",
      documentId: "kb:busy.md",
      path: "busy.md",
      label: "Busy document",
      citationCount: 7,
      firstCitedAt: "2026-01-05T10:00:00.000Z",
      lastCitedAt: "2026-07-20T09:30:00.000Z",
      indexed: true,
      citedSectionCount: 2,
      sectionCount: 3
    }
  ],
  total: 2
};

test("a never-cited row reads as never cited, with its zero count", () => {
  const html = view(documentReport);
  assert.match(html, /Cold document/);
  assert.match(html, /0 citations/);
  assert.match(html, /Never cited/);
  assert.match(html, /0\/3 sections cited/);
});

test("a cited row shows its count and the date it was last cited", () => {
  const html = view(documentReport);
  assert.match(html, /7 citations/);
  assert.match(html, /Last cited 2026-07-20/);
  assert.match(html, /First cited 2026-01-05/);
});

test("counters whose section is gone are called out rather than hidden", () => {
  const html = view(
    {
      ...documentReport,
      summary: { ...documentReport.summary, unindexedUsageRows: 1 },
      rows: [
        {
          key: "kb:guide.md#old-heading",
          documentId: "kb:guide.md",
          anchor: "old-heading",
          path: "guide.md",
          label: "Old heading",
          citationCount: 9,
          lastCitedAt: "2026-05-01T00:00:00.000Z",
          indexed: false
        }
      ],
      total: 1
    },
    "section"
  );

  assert.match(html, /No longer indexed/);
  assert.match(html, /guide.md#old-heading/);
  assert.match(html, /1 counted section is\s*no longer indexed/);
});

test("an empty index explains itself instead of rendering a bare list", () => {
  const html = view({
    summary: {
      indexedSections: 0,
      citedSections: 0,
      uncitedSections: 0,
      indexedDocuments: 0,
      citedDocuments: 0,
      uncitedDocuments: 0,
      totalCitations: 0,
      unindexedUsageRows: 0
    },
    rows: [],
    total: 0
  });

  assert.match(html, /Nothing indexed yet/);
});
