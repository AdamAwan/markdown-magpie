import type { AppContext } from "../../context.js";
import { selectFlow } from "../../platform/repositories.js";

export interface RetrieveRequest {
  question: string;
  flowId?: string;
  limit?: number;
}

interface RetrievedSection {
  sectionId: string;
  // The owning document and the section's in-document anchor, carried so the
  // watcher can build faithful citations (the answer-question job's citation
  // contract requires both) without a second round-trip to the index.
  documentId: string;
  anchor: string;
  path: string;
  heading: string;
  content: string;
  // The section's fused retrieval relevance in [0,1]. Carried so citations can
  // show/sort by strength and so weak matches can be floored out (below).
  relevance: number;
}

export type RetrieveResult =
  | { ok: true; sections: RetrievedSection[] }
  | { ok: false; code: "unknown_flow" };

// Sections below this fused-relevance floor are dropped rather than returned as
// weak filler. Without it, hybrid search always yields its top-K (vector search
// returns nearest neighbours for any query), so even a bogus question produced a
// full set of citations. Conservative on purpose: it removes clear non-matches,
// not borderline hits. When nothing clears the floor the caller gets an empty
// list and treats the question as a knowledge gap.
const MIN_RELEVANCE = 0.15;

// Pure (non-generative) retrieval the watcher calls after it has routed the
// question to a flow. Resolving the flow's destination scope server-side keeps
// the pgvector knowledge index inside the API; the watcher is HTTP-only.
export async function retrieve(ctx: AppContext, request: RetrieveRequest): Promise<RetrieveResult> {
  const scope = resolveRepositoryScope(ctx, request.flowId);
  if (!scope.ok) {
    return scope;
  }
  const limit = request.limit ?? 5;

  const ranked = await ctx.stores.knowledgeIndex.search(request.question, limit, scope.repositoryIds);
  return {
    ok: true,
    sections: ranked
      .filter(({ relevance }) => relevance >= MIN_RELEVANCE)
      .map(({ section, relevance }) => ({
        sectionId: section.id,
        documentId: section.documentId,
        anchor: section.anchor,
        path: section.path,
        heading: section.heading,
        content: section.content,
        relevance
      }))
  };
}

// Maps a flowId to the repository scope its destination defines, mirroring how
// the old ask() routing scoped retrieval. An absent flowId is the deliberate
// unscoped case; a flowId that names no configured flow is a caller error
// (e.g. a stale/typo'd id) and is surfaced rather than silently broadened to a
// cross-flow search.
function resolveRepositoryScope(
  ctx: AppContext,
  flowId: string | undefined
): { ok: true; repositoryIds: string[] | undefined } | { ok: false; code: "unknown_flow" } {
  if (!flowId) {
    return { ok: true, repositoryIds: undefined };
  }
  const flow = selectFlow(ctx.repositoryDeps(), flowId);
  if (!flow) {
    return { ok: false, code: "unknown_flow" };
  }
  return { ok: true, repositoryIds: flow.destinationId ? [flow.destinationId] : undefined };
}
