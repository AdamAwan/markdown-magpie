import type { AppContext } from "../context.js";

const SPLIT_SIMILARITY_THRESHOLD = 0.55;
const SPLIT_MAX_NEIGHBOURS = 5;

export async function splitNeighbours(
  ctx: AppContext,
  doc: { path: string; content: string },
  repositoryIds: string[] | undefined
): Promise<Array<{ path: string; content: string }>> {
  const ranked = await ctx.stores.knowledgeIndex.search(doc.content, SPLIT_MAX_NEIGHBOURS * 4, repositoryIds);
  const bestByPath = new Map<string, number>();

  for (const { section, relevance } of ranked) {
    if (section.path === doc.path) continue;

    const previous = bestByPath.get(section.path);
    if (previous === undefined || relevance > previous) {
      bestByPath.set(section.path, relevance);
    }
  }

  const contentByPath = new Map(
    ctx.stores.knowledgeIndex.listDocuments().map((document) => [document.path, document.content])
  );

  return [...bestByPath.entries()]
    .filter(([, relevance]) => relevance >= SPLIT_SIMILARITY_THRESHOLD)
    .sort((left, right) => right[1] - left[1])
    .slice(0, SPLIT_MAX_NEIGHBOURS)
    .map(([path]) => ({ path, content: contentByPath.get(path) }))
    .filter((neighbour): neighbour is { path: string; content: string } => neighbour.content !== undefined);
}
