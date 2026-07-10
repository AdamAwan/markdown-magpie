import type { KnowledgeDocument, Proposal, ProvenanceClaim } from "@magpie/core";
import { parseMarkdownDocument, slugify, splitIntoSections } from "@magpie/markdown";

// Folds a document's provenance event stream (merged proposals, oldest first —
// Task 1's listMergedByTargetPath order) into the current advisory claim set
// for the verify patrol (#214 phase 2). Later events supersede earlier ones per
// (anchor ?? claim) key. Claims whose anchor names a section heading that no
// longer exists in `currentContent` are DROPPED — a stale anchor must fall back
// to full re-derivation, never risk a false "cited support changed" verdict.
// Events with no provenance contribute nothing (pre-feature merges, human-edit
// gaps): the fold is advisory by design and consumers must tolerate holes.
export function foldProvenanceEvents(events: Proposal[], currentContent: string): ProvenanceClaim[] {
  const byKey = new Map<string, ProvenanceClaim>();
  for (const event of events) {
    for (const claim of event.provenance ?? []) {
      const key = claim.anchor ?? claim.claim;
      // Delete-then-set so a superseding claim takes its own event's position:
      // output order is event order, then within-event order, for the events
      // that actually contributed the surviving claims.
      byKey.delete(key);
      byKey.set(key, claim);
    }
  }
  if (byKey.size === 0) {
    return [];
  }
  const liveAnchors = documentAnchors(currentContent);
  return [...byKey.values()].filter((claim) => claim.anchor === undefined || liveAnchors.has(claim.anchor));
}

// Every anchor the current document content answers to. Reuses the sectioniser
// (the ONLY heading→anchor implementation) rather than re-parsing headings by
// hand: it accepts both forms in circulation — the indexer's Citation.anchor
// (the slug of the joined heading path, e.g. "deploy-rollback") and the plain
// per-heading slug the drafting prompts describe ("rollback").
function documentAnchors(content: string): Set<string> {
  const document: KnowledgeDocument = {
    id: "provenance-fold",
    repositoryId: "provenance-fold",
    path: "provenance-fold.md",
    metadata: parseMarkdownDocument(content).metadata,
    content
  };
  const anchors = new Set<string>();
  for (const section of splitIntoSections(document)) {
    anchors.add(section.anchor);
    const headingSlug = slugify(section.heading);
    if (headingSlug) {
      anchors.add(headingSlug);
    }
  }
  return anchors;
}
