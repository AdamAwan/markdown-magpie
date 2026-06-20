import type { AppContext } from "../../context.js";
import { selectFlow } from "../../platform/repositories.js";

export interface RetrieveRequest {
  question: string;
  flowId?: string;
  limit?: number;
}

export interface RetrievedSection {
  sectionId: string;
  path: string;
  heading: string;
  content: string;
}

export interface RetrieveResult {
  sections: RetrievedSection[];
}

// Pure (non-generative) retrieval the watcher calls after it has routed the
// question to a flow. Resolving the flow's destination scope server-side keeps
// the pgvector knowledge index inside the API; the watcher is HTTP-only.
export async function retrieve(ctx: AppContext, request: RetrieveRequest): Promise<RetrieveResult> {
  const repositoryIds = resolveRepositoryScope(ctx, request.flowId);
  const limit = request.limit ?? 5;

  const ranked = await ctx.stores.knowledgeIndex.search(request.question, limit, repositoryIds);
  return {
    sections: ranked.map(({ section }) => ({
      sectionId: section.id,
      path: section.path,
      heading: section.heading,
      content: section.content
    }))
  };
}

// Maps a flowId to the repository scope its destination defines, mirroring how
// the old ask() routing scoped retrieval. An unknown/absent flowId searches
// unscoped (undefined repositoryIds).
function resolveRepositoryScope(ctx: AppContext, flowId: string | undefined): string[] | undefined {
  if (!flowId) {
    return undefined;
  }
  const flow = selectFlow(ctx.repositoryDeps(), flowId);
  return flow?.destinationId ? [flow.destinationId] : undefined;
}
