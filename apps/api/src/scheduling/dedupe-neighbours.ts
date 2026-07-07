import type { AppContext } from "../context.js";

// The similarity bar a neighbour must clear to be worth a dedupe scan. Adaptive by
// nature: a document with nothing this close yields no neighbours, so the lens stays
// silent on isolated docs. The hard cap bounds per-scan cost. Both tunable; see
// docs/maintenance-redesign.md (Decisions: neighbourhood size k).
const DEDUPE_SIMILARITY_THRESHOLD = 0.75;
const DEDUPE_MAX_NEIGHBOURS = 5;

// The patrolled document's nearest neighbour DOCUMENTS, above the similarity bar and
// capped. The shared KB search ranks SECTIONS, so we fold them to documents (keeping
// each document's best section score), drop the document itself, threshold, sort, cap,
// and resolve each surviving path to its full content for the dedupe job.
export async function dedupeNeighbours(
  ctx: AppContext,
  doc: { path: string; content: string },
  repositoryIds: string[] | undefined
): Promise<Array<{ path: string; content: string }>> {
  // Over-fetch sections so several sections of one document don't crowd out distinct
  // neighbours before the fold-to-document step.
  const ranked = await ctx.stores.knowledgeIndex.search(doc.content, DEDUPE_MAX_NEIGHBOURS * 4, repositoryIds);

  const bestByPath = new Map<string, number>();
  for (const { section, relevance } of ranked) {
    if (section.path === doc.path) {
      continue;
    }
    const previous = bestByPath.get(section.path);
    if (previous === undefined || relevance > previous) {
      bestByPath.set(section.path, relevance);
    }
  }

  const contentByPath = new Map(ctx.stores.knowledgeIndex.listDocuments().map((document) => [document.path, document.content]));

  return [...bestByPath.entries()]
    .filter(([, score]) => score >= DEDUPE_SIMILARITY_THRESHOLD)
    .sort((left, right) => right[1] - left[1])
    .slice(0, DEDUPE_MAX_NEIGHBOURS)
    .map(([path]) => ({ path, content: contentByPath.get(path) }))
    .filter((neighbour): neighbour is { path: string; content: string } => neighbour.content !== undefined);
}
