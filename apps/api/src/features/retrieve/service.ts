import type { ExistingDocumentContext } from "@magpie/core";
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

// Scope grounding for judging whether a gap cluster is off-topic: what the flow's
// knowledge base covers, relative to a query. Runs the same inline hybrid search
// retrieval uses (embeddings are computed in the API), but WITHOUT the relevance
// floor so the model always sees the closest content even when weak — the point is
// to show how (un)related the query is. `topRelevance` is 0 when nothing matched.
export interface FlowScopeContext {
  persona?: string;
  topRelevance: number;
  snippets: string[];
}

const SCOPE_SNIPPET_LIMIT = 3;
const SCOPE_SNIPPET_CHARS = 200;

export async function describeFlowScope(
  ctx: AppContext,
  flowId: string | undefined,
  query: string
): Promise<FlowScopeContext | undefined> {
  const scope = resolveRepositoryScope(ctx, flowId);
  if (!scope.ok) {
    return undefined;
  }
  const flow = flowId ? selectFlow(ctx.repositoryDeps(), flowId) : undefined;
  const ranked = await ctx.stores.knowledgeIndex.search(query, SCOPE_SNIPPET_LIMIT, scope.repositoryIds);
  const topRelevance = ranked.length > 0 ? Math.max(...ranked.map(({ relevance }) => relevance)) : 0;
  const snippets = ranked
    .slice(0, SCOPE_SNIPPET_LIMIT)
    .map(({ section }) => section.content.slice(0, SCOPE_SNIPPET_CHARS));
  return {
    ...(flow?.persona ? { persona: flow.persona } : {}),
    topRelevance,
    snippets
  };
}

// Existing-doc grounding for the seed outline generator: the flow's own sections
// most relevant to a topic, so the model proposes docs that fit the current
// structure and don't restate what's covered. Like describeFlowScope it runs the
// same inline hybrid search WITHOUT the relevance floor (the point is to show the
// nearest structure even when the topic is only loosely covered), but returns
// per-section path/heading/excerpt rather than a scalar. Returns [] for an unknown
// flow — the caller has already validated the flow; this is best-effort grounding.
const EXISTING_DOC_EXCERPT_CHARS = 240;

export async function describeExistingDocuments(
  ctx: AppContext,
  flowId: string | undefined,
  query: string,
  limit = 8
): Promise<ExistingDocumentContext[]> {
  const scope = resolveRepositoryScope(ctx, flowId);
  if (!scope.ok) {
    return [];
  }
  const ranked = await ctx.stores.knowledgeIndex.search(query, limit, scope.repositoryIds);
  return ranked.map(({ section }) => ({
    path: section.path,
    heading: section.heading,
    excerpt: section.content.slice(0, EXISTING_DOC_EXCERPT_CHARS)
  }));
}

// Whole-flow document inventory for the seed planner: every destination doc's
// path + title, unscored (the planner needs the full structure, not a top-k for
// a query). Bounded to keep the prompt sane on huge KBs.
export function listExistingDocuments(ctx: AppContext, flowId: string, limit = 200): ExistingDocumentContext[] {
  const scope = resolveRepositoryScope(ctx, flowId);
  if (!scope.ok) {
    return [];
  }
  const filter = scope.repositoryIds ? new Set(scope.repositoryIds) : undefined;
  return ctx.stores.knowledgeIndex
    .listDocuments()
    .filter((doc) => !filter || filter.has(doc.repositoryId))
    .slice(0, limit)
    .map((doc) => ({ path: doc.path, heading: doc.metadata.title || doc.path }));
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
