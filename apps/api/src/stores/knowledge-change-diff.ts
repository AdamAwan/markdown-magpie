import type { KnowledgeChangeKind } from "@magpie/core";

// The minimum a section must expose to be diffed. DocumentSection satisfies it
// structurally, so callers pass indexed sections directly — but the diff itself
// never needs the ordinal-derived section id, which is exactly the point.
export interface DiffSection {
  documentId: string;
  anchor: string;
  heading: string;
  content: string;
  ordinal: number;
}

// One side of the comparison: the documents of a repository and their sections.
export interface KnowledgeSnapshot {
  documents: Array<{ id: string; path: string }>;
  sections: DiffSection[];
}

// A change the diff observed, before any cause attribution or storage identity is
// attached. Document-level kinds carry no anchor/heading.
export interface KnowledgeChangeDraft {
  documentId: string;
  path: string;
  anchor?: string;
  heading?: string;
  kind: KnowledgeChangeKind;
}

// One document's sections collapsed onto the durable anchor identity. Defensive
// fold: splitIntoSections de-duplicates anchors within a document with a numeric
// suffix, but this function takes plain section lists from any caller, and two
// entries sharing an anchor must read as ONE identity (content concatenated)
// rather than as a spurious add/remove pair.
interface AnchoredSection {
  heading: string;
  content: string;
  ordinal: number;
}

function anchorsByDocument(sections: DiffSection[]): Map<string, Map<string, AnchoredSection>> {
  const byDocument = new Map<string, Map<string, AnchoredSection>>();
  const ordered = [...sections].sort((left, right) => left.ordinal - right.ordinal);

  for (const section of ordered) {
    let anchors = byDocument.get(section.documentId);
    if (!anchors) {
      anchors = new Map<string, AnchoredSection>();
      byDocument.set(section.documentId, anchors);
    }
    const existing = anchors.get(section.anchor);
    if (existing) {
      existing.content = `${existing.content}\n${section.content}`;
      continue;
    }
    anchors.set(section.anchor, { heading: section.heading, content: section.content, ordinal: section.ordinal });
  }

  return byDocument;
}

/**
 * Diffs two states of a repository's indexed corpus into change-log drafts.
 *
 * Pure: no clock, no ids, no database. The whole design of the change log rests
 * on WHAT this compares — `(documentId, anchor)`, never `sectionId`. `sectionId`
 * is `<documentId>:<ordinal>`, so an ordinal-keyed comparison shears every
 * section below an inserted one into a false "changed"; anchors survive an
 * insert untouched and only a genuinely edited body reads as a change.
 *
 * A document present on only one side yields a single document-level entry: an
 * added document's sections are not enumerated as N `section_added` entries,
 * because "this document is new" is the fact a reader wants and the per-section
 * list is noise. Sections are compared only for documents present on both sides.
 */
export function diffKnowledgeSnapshots(before: KnowledgeSnapshot, after: KnowledgeSnapshot): KnowledgeChangeDraft[] {
  const beforeDocuments = new Map(before.documents.map((document) => [document.id, document]));
  const afterDocuments = new Map(after.documents.map((document) => [document.id, document]));
  const beforeAnchors = anchorsByDocument(before.sections);
  const afterAnchors = anchorsByDocument(after.sections);

  const drafts: KnowledgeChangeDraft[] = [];
  const documentIds = [...new Set([...beforeDocuments.keys(), ...afterDocuments.keys()])].sort();

  for (const documentId of documentIds) {
    const beforeDocument = beforeDocuments.get(documentId);
    const afterDocument = afterDocuments.get(documentId);

    if (!beforeDocument && afterDocument) {
      drafts.push({ documentId, path: afterDocument.path, kind: "document_added" });
      continue;
    }
    if (beforeDocument && !afterDocument) {
      drafts.push({ documentId, path: beforeDocument.path, kind: "document_removed" });
      continue;
    }
    if (!afterDocument) {
      continue;
    }

    const priorSections = beforeAnchors.get(documentId) ?? new Map<string, AnchoredSection>();
    const currentSections = afterAnchors.get(documentId) ?? new Map<string, AnchoredSection>();
    const anchors = [...new Set([...priorSections.keys(), ...currentSections.keys()])].sort();

    for (const anchor of anchors) {
      const prior = priorSections.get(anchor);
      const current = currentSections.get(anchor);

      if (!prior && current) {
        drafts.push({
          documentId,
          path: afterDocument.path,
          anchor,
          heading: current.heading,
          kind: "section_added"
        });
        continue;
      }
      if (prior && !current) {
        drafts.push({
          documentId,
          path: afterDocument.path,
          anchor,
          heading: prior.heading,
          kind: "section_removed"
        });
        continue;
      }
      if (prior && current && prior.content !== current.content) {
        drafts.push({
          documentId,
          path: afterDocument.path,
          anchor,
          heading: current.heading,
          kind: "section_changed"
        });
      }
    }
  }

  return drafts;
}
