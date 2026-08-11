import type { ExistingDocumentContext } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { selectFlow } from "../../platform/repositories.js";
import { retrievalMode } from "../../platform/providers.js";

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
  | { ok: true; sections: RetrievedSection[]; retrievalMode: "hybrid" | "keyword"; candidateCount: number }
  | { ok: false; code: "unknown_flow" };

// Absolute floor: a section this weak is a clear non-match regardless of what
// else scored. Conservative on purpose — it removes noise, not borderline hits.
//
// Re-derived in Task 7 against the golden KB, because `ts_rank_cd(..., 32)` =
// rank/(rank+1) replaced the old rank/(rank+0.1) normalisation and the old 0.15
// no longer means what it meant. Measured distribution (see the task-7 report):
// a section matching a single body (C-weight) lexeme scores exactly 0.2308
// (raw 0.3), a single path/heading-path (B-weight) lexeme exactly 0.3750
// (raw 0.6), and the weakest genuinely answer-bearing section measured 0.7143
// (raw 2.5). 0.40 (raw 0.667) is the lowest round value clear of that noise
// band — chosen at the bottom of the empty band rather than its middle because
// this floor is also applied to hybrid's fused relevance, which is
// max(cosine similarity, keyword relevance); a higher value would prune real
// vector hits in a mode this environment cannot measure (see R16).
const MIN_RELEVANCE = 0.4;
// Relative floor: keep sections within this fraction of the best result. OR'd
// keyword matching (see PostgresKnowledgeStore.searchByKeyword) surfaces
// single-term hits that hybrid retrieval never produced, so a strong result now
// implies its weak neighbours are noise.
//
// The two floors do different jobs, which is why both exist. The absolute floor
// alone returns nothing when every candidate is weak — and in keyword mode
// "nothing" is read downstream as evidence the knowledge base does not cover the
// question, which is exactly the false signal this design removes. So the
// relative floor is only allowed to cut when there IS a strong result to be
// relative to: weak-but-best results survive, weak-beside-strong results do not.
//
// Raised from 0.35 to 0.5 in Task 7 for a mechanical reason: relevance is capped
// at 1, so the relative floor can only ever cut below `1 * fraction`. At 0.35 —
// with MIN_RELEVANCE now 0.4 — it could never cut anything the absolute floor
// had not already cut, i.e. the "two-part" floor had silently collapsed to one
// part. 0.5 ("at least half as strong as the best hit") is the lowest round
// value that makes it reachable again.
//
// Reachable, but on the keyword leg still not much more than that: it can only
// cut inside [0.4, top * 0.5), which is empty unless top > 0.8, and even at
// top = 1.0 the live band [0.4, 0.5) falls inside the measured-empty gap between
// single-lexeme noise (<= 0.375) and real signal (>= 0.714) — so on the
// quantised keyword scale nothing lands in it. This floor genuinely bites only
// on the continuous cosine leg. Treat it as a hybrid-mode mechanism; see R16 in
// docs/retrieval.md.
const RELATIVE_RELEVANCE_FLOOR = 0.5;

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
  const topRelevance = ranked.length > 0 ? Math.max(...ranked.map(({ relevance }) => relevance)) : 0;
  const relativeFloor = topRelevance * RELATIVE_RELEVANCE_FLOOR;

  return {
    ok: true,
    retrievalMode: retrievalMode(ctx.settings).mode,
    // Counted before the floor so the caller can tell "nothing matched" from
    // "matches existed but were filtered" — the distinction the watcher needs to
    // avoid reading a lexical miss as evidence of absence.
    candidateCount: ranked.length,
    sections: ranked
      .filter(({ relevance }) => relevance >= MIN_RELEVANCE && relevance >= relativeFloor)
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
