import type { DocumentSection, KnowledgeDocument, SectionCitationUsage } from "@magpie/core";

// The citation-usage report (spec 2026-07-25-citation-usage-tracking): how often
// each indexed section has been cited by an answer, so a human deciding what to
// trim from the knowledge base can see what is and is not earning its keep.
//
// Pure planner — it takes the live index (documents + sections) and the durable
// usage counters and joins them. Two things make the join more than a lookup:
//
//   - Sections with NO counter row are the whole point. They are reported with
//     count 0, and the default ordering puts them first.
//   - Counter rows with no live section are kept too, flagged `indexed: false`.
//     A section that was cited 40 times and then deleted or renamed is exactly
//     what someone auditing the knowledge base wants to see, and dropping it
//     would quietly turn "we removed something people used" into silence.

type CitationUsageGroup = "section" | "document";
type CitationUsageSort = "least" | "most" | "recent";

interface CitationUsageRow {
  /** `<documentId>#<anchor>` for a section row, `<documentId>` for a document row. */
  key: string;
  documentId: string;
  /** Absent on a document row. */
  anchor?: string;
  path: string;
  /** Section heading, or the document title on a document row. */
  label: string;
  citationCount: number;
  firstCitedAt?: string;
  lastCitedAt?: string;
  /** False when the row describes a section/document that is no longer indexed. */
  indexed: boolean;
  /** Document rows only: how many of the document's sections have ever been cited. */
  citedSectionCount?: number;
  /** Document rows only: how many sections the document currently has. */
  sectionCount?: number;
}

interface CitationUsageSummary {
  indexedSections: number;
  citedSections: number;
  uncitedSections: number;
  indexedDocuments: number;
  citedDocuments: number;
  uncitedDocuments: number;
  /** Total citations counted across every section, including unindexed ones. */
  totalCitations: number;
  /** Counter rows describing sections that are no longer in the index. */
  unindexedUsageRows: number;
}

export interface CitationUsageReport {
  summary: CitationUsageSummary;
  rows: CitationUsageRow[];
  total: number;
}

export interface CitationUsageOptions {
  group: CitationUsageGroup;
  sort: CitationUsageSort;
  limit: number;
  offset: number;
  /** Narrows the report to one indexed repository (a destination KB). */
  repositoryId?: string;
}

function usageKey(documentId: string, anchor: string): string {
  return `${documentId}#${anchor}`;
}

// Section identity is (documentId, anchor) — see the migration comment. Sections
// carry both, so the join key is read straight off the section.
function sectionKey(section: DocumentSection): string {
  return usageKey(section.documentId, section.anchor);
}

function documentTitle(document: KnowledgeDocument | undefined, path: string): string {
  return document?.metadata.title ?? path;
}

// Ordering. `least` is the trim ordering: never-cited first, then the ones whose
// last citation is oldest, then alphabetically so the list is stable between
// polls. `most` and `recent` are the mirror views ("what carries the KB?" and
// "what did we lean on lately?"), and both fall back to the same stable tiebreak.
function compareRows(sort: CitationUsageSort): (left: CitationUsageRow, right: CitationUsageRow) => number {
  const byPath = (left: CitationUsageRow, right: CitationUsageRow) =>
    left.path.localeCompare(right.path) || left.key.localeCompare(right.key);

  if (sort === "most") {
    return (left, right) => right.citationCount - left.citationCount || byPath(left, right);
  }

  if (sort === "recent") {
    // Never-cited rows have no lastCitedAt; they sort last here, which is the
    // right answer for "what was used most recently?".
    return (left, right) => (right.lastCitedAt ?? "").localeCompare(left.lastCitedAt ?? "") || byPath(left, right);
  }

  return (left, right) =>
    left.citationCount - right.citationCount ||
    // "" (never cited) sorts before any timestamp, keeping the coldest first.
    (left.lastCitedAt ?? "").localeCompare(right.lastCitedAt ?? "") ||
    byPath(left, right);
}

export function buildCitationUsageReport(
  input: {
    documents: KnowledgeDocument[];
    sections: DocumentSection[];
    usage: SectionCitationUsage[];
  },
  options: CitationUsageOptions
): CitationUsageReport {
  const documentsById = new Map(input.documents.map((document) => [document.id, document]));
  const documentIds = options.repositoryId
    ? new Set(
        input.documents
          .filter((document) => document.repositoryId === options.repositoryId)
          .map((document) => document.id)
      )
    : undefined;

  const inScope = (documentId: string): boolean => !documentIds || documentIds.has(documentId);
  const sections = input.sections.filter((section) => inScope(section.documentId));
  // A usage row for a document that is no longer indexed cannot be attributed to
  // a repository, so a repository-scoped report can only include the ones whose
  // document id is still known. Unscoped reports keep them all.
  const usage = input.usage.filter((row) => inScope(row.documentId));
  const usageByKey = new Map(usage.map((row) => [usageKey(row.documentId, row.anchor), row]));

  const sectionRows: CitationUsageRow[] = sections.map((section) => {
    const counted = usageByKey.get(sectionKey(section));
    return {
      key: sectionKey(section),
      documentId: section.documentId,
      anchor: section.anchor,
      path: section.path,
      label: section.heading,
      citationCount: counted?.citationCount ?? 0,
      ...(counted ? { firstCitedAt: counted.firstCitedAt, lastCitedAt: counted.lastCitedAt } : {}),
      indexed: true
    };
  });

  const indexedKeys = new Set(sectionRows.map((row) => row.key));
  const unindexedRows: CitationUsageRow[] = usage
    .filter((row) => !indexedKeys.has(usageKey(row.documentId, row.anchor)))
    .map((row) => ({
      key: usageKey(row.documentId, row.anchor),
      documentId: row.documentId,
      anchor: row.anchor,
      path: row.path,
      label: row.heading,
      citationCount: row.citationCount,
      firstCitedAt: row.firstCitedAt,
      lastCitedAt: row.lastCitedAt,
      indexed: false
    }));

  const summary = summarize(sectionRows, unindexedRows, documentsById, documentIds);
  const rows =
    options.group === "document"
      ? documentRows(sectionRows, unindexedRows, documentsById)
      : [...sectionRows, ...unindexedRows];

  rows.sort(compareRows(options.sort));
  return {
    summary,
    rows: rows.slice(options.offset, options.offset + options.limit),
    total: rows.length
  };
}

// Rolls sections up to their document — the unit a trim actually operates on,
// since files are what get deleted. A document counts as cited when ANY of its
// sections has been cited; its count is the sum across sections, so a document
// answering many questions through one section still reads as busy.
function documentRows(
  sectionRows: CitationUsageRow[],
  unindexedRows: CitationUsageRow[],
  documentsById: Map<string, KnowledgeDocument>
): CitationUsageRow[] {
  const byDocument = new Map<string, CitationUsageRow>();

  for (const row of [...sectionRows, ...unindexedRows]) {
    const document = documentsById.get(row.documentId);
    const existing = byDocument.get(row.documentId);
    if (!existing) {
      byDocument.set(row.documentId, {
        key: row.documentId,
        documentId: row.documentId,
        path: document?.path ?? row.path,
        label: documentTitle(document, document?.path ?? row.path),
        citationCount: row.citationCount,
        ...(row.firstCitedAt ? { firstCitedAt: row.firstCitedAt } : {}),
        ...(row.lastCitedAt ? { lastCitedAt: row.lastCitedAt } : {}),
        indexed: Boolean(document),
        citedSectionCount: row.citationCount > 0 ? 1 : 0,
        sectionCount: row.indexed ? 1 : 0
      });
      continue;
    }

    existing.citationCount += row.citationCount;
    existing.citedSectionCount = (existing.citedSectionCount ?? 0) + (row.citationCount > 0 ? 1 : 0);
    existing.sectionCount = (existing.sectionCount ?? 0) + (row.indexed ? 1 : 0);
    if (row.firstCitedAt && (!existing.firstCitedAt || row.firstCitedAt < existing.firstCitedAt)) {
      existing.firstCitedAt = row.firstCitedAt;
    }
    if (row.lastCitedAt && (!existing.lastCitedAt || row.lastCitedAt > existing.lastCitedAt)) {
      existing.lastCitedAt = row.lastCitedAt;
    }
  }

  return [...byDocument.values()];
}

function summarize(
  sectionRows: CitationUsageRow[],
  unindexedRows: CitationUsageRow[],
  documentsById: Map<string, KnowledgeDocument>,
  documentIds: Set<string> | undefined
): CitationUsageSummary {
  let citedSections = 0;
  for (const row of sectionRows) {
    if (row.citationCount > 0) {
      citedSections += 1;
    }
  }

  // A document counts as cited when any of its usage — live section or a stale
  // counter row from a since-renamed heading — is non-zero, as long as the
  // document itself is still indexed. Counters for deleted documents are reported
  // separately (unindexedUsageRows) rather than inflating the document totals.
  const citedDocuments = new Set(
    [...sectionRows, ...unindexedRows]
      .filter((row) => row.citationCount > 0 && documentsById.has(row.documentId))
      .map((row) => row.documentId)
  );

  const indexedDocuments = documentIds ? documentIds.size : documentsById.size;
  const totalCitations = [...sectionRows, ...unindexedRows].reduce((sum, row) => sum + row.citationCount, 0);

  return {
    indexedSections: sectionRows.length,
    citedSections,
    uncitedSections: sectionRows.length - citedSections,
    indexedDocuments,
    citedDocuments: citedDocuments.size,
    // Documents whose every section is uncited. Counted off the live index, so a
    // document that has since been deleted is not resurrected as "uncited".
    uncitedDocuments: indexedDocuments - citedDocuments.size,
    totalCitations,
    unindexedUsageRows: unindexedRows.length
  };
}
