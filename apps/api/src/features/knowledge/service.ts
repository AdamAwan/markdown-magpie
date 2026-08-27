import type { DocumentSection, KnowledgeChange } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { resolveIndexSelection } from "../../platform/repositories.js";
import { buildCitationUsageReport, type CitationUsageOptions, type CitationUsageReport } from "./citation-usage.js";
import type { KnowledgeChangesReport, KnowledgeChangeView, ParsedChangeQuery } from "./changes.js";
import type { KnowledgeChangeFilters } from "../../stores/knowledge-change-store.js";
import * as sourceSyncService from "../source-sync/service.js";

export function knowledgeRepositoryErrorCode(message: string): string {
  if (message === "local_path_required") {
    return "local_path_required";
  }

  if (message === "local_path_outside_root") {
    return "local_path_outside_root";
  }

  if (message.includes("localPath is not accepted")) {
    return "local_path_not_allowed";
  }

  if (
    message.includes("cannot_be_checked_out") ||
    message.includes("repository_url_required") ||
    message === "configured_repository_not_indexable"
  ) {
    return "configured_repository_not_indexable";
  }

  return "configured_repository_required";
}

export interface IndexRepositoryPayload {
  flowId?: string;
  localPath?: string;
  repositoryId?: string;
  name?: string;
}

/**
 * Resolves which repository to index from the request payload. Throws on a
 * resolution failure, which the handler maps to a 400 via
 * {@link knowledgeRepositoryErrorCode}. This is kept distinct from
 * {@link indexSelection} so that only resolution failures produce a 400 while
 * an indexing failure bubbles up (a 500) exactly as before.
 */
export async function resolveSelection(
  ctx: AppContext,
  payload: IndexRepositoryPayload
): Promise<{ localPath: string; repositoryId?: string; name?: string }> {
  return resolveIndexSelection(ctx.repositoryDeps(), payload);
}

export async function indexSelection(
  ctx: AppContext,
  selection: { localPath: string; repositoryId?: string; name?: string }
): Promise<Awaited<ReturnType<AppContext["stores"]["knowledgeIndex"]["indexLocalRepository"]>>> {
  const summary = await ctx.stores.knowledgeIndex.indexLocalRepository({
    localPath: selection.localPath,
    repositoryId: selection.repositoryId,
    name: selection.name
  });
  void ctx.embedder.trigger();
  return summary;
}

export async function search(
  ctx: AppContext,
  query: string,
  limit: number
): Promise<Awaited<ReturnType<AppContext["stores"]["knowledgeIndex"]["search"]>>> {
  return ctx.stores.knowledgeIndex.search(query, limit);
}

// Resolves one indexed section in full — the lookup MCP's kb_citation uses to
// expand a citation's excerpt into the complete evidence passage.
export function getSection(ctx: AppContext, id: string): DocumentSection | undefined {
  return ctx.stores.knowledgeIndex.getSection(id);
}

export interface PaginationOptions {
  limit: number;
  offset: number;
}

export function listRepositories(
  ctx: AppContext,
  pagination: PaginationOptions
): { repositories: ReturnType<AppContext["stores"]["knowledgeIndex"]["listRepositories"]>; total: number } {
  return {
    repositories: ctx.stores.knowledgeIndex.listRepositories(pagination),
    total: ctx.stores.knowledgeIndex.countRepositories()
  };
}

export function listDocuments(
  ctx: AppContext,
  pagination: PaginationOptions
): { documents: ReturnType<AppContext["stores"]["knowledgeIndex"]["listDocuments"]>; total: number } {
  return {
    documents: ctx.stores.knowledgeIndex.listDocuments(pagination),
    total: ctx.stores.knowledgeIndex.countDocuments()
  };
}

// The citation-usage report: the durable per-section citation counters joined
// against the live index, so never-cited sections show up as the zeroes they are
// (spec 2026-07-25-citation-usage-tracking). Read-only — nothing acts on it; it
// exists so a human trimming the knowledge base can see what a cut would cost.
export async function citationUsage(ctx: AppContext, options: CitationUsageOptions): Promise<CitationUsageReport> {
  const usage = await ctx.stores.questionLogs.listSectionCitationUsage();
  return buildCitationUsageReport(
    {
      documents: ctx.stores.knowledgeIndex.listDocuments(),
      sections: ctx.stores.knowledgeIndex.listSections(),
      usage
    },
    options
  );
}

export interface KnowledgeChangesOptions {
  query: ParsedChangeQuery;
  /**
   * The flows this read may cover, or undefined for "every flow, plus entries
   * that belong to none". The route resolves it from the requested `flowId` and
   * the caller's per-flow read capabilities.
   */
  flowIds?: string[];
  limit: number;
  offset: number;
}

/**
 * The knowledge change log, filtered and paginated, with the aggregate over the
 * SAME window (spec 2026-08-27-knowledge-change-log). Rows and summary come from
 * one filter set so they can never describe different windows, and the summary
 * also carries the log's start instant for the requested scope so an empty window
 * is legible as "nothing recorded yet".
 */
export async function knowledgeChanges(
  ctx: AppContext,
  options: KnowledgeChangesOptions
): Promise<KnowledgeChangesReport> {
  const { flowId: _flowId, ...rest } = options.query;
  const filters: KnowledgeChangeFilters = { ...rest, ...(options.flowIds ? { flowIds: options.flowIds } : {}) };

  const [changes, summary, logStartedAt] = await Promise.all([
    ctx.stores.knowledgeChanges.list({ ...filters, limit: options.limit, offset: options.offset }),
    ctx.stores.knowledgeChanges.summarize(filters),
    // Scoped by identity only: the window is what may be empty, so bounding the
    // start instant by it would defeat the point.
    ctx.stores.knowledgeChanges.firstChangedAt({
      ...(filters.flowIds ? { flowIds: filters.flowIds } : {}),
      ...(filters.documentId ? { documentId: filters.documentId } : {}),
      ...(filters.sourceId ? { sourceId: filters.sourceId } : {})
    })
  ]);

  return {
    changes: await withUpstreamFileCounts(ctx, changes),
    summary: { ...summary, ...(logStartedAt ? { logStartedAt } : {}) },
    limit: options.limit,
    offset: options.offset
  };
}

/**
 * Joins the causing sync run's file counts onto the source-sync entries of one
 * page, so a surface showing a commit range can render "1,412 files changed
 * upstream (1,000 examined)". One lookup per distinct job on the page, and a run
 * that no longer resolves simply leaves the entry undecorated — attribution is a
 * decoration, never a dependency.
 */
async function withUpstreamFileCounts(ctx: AppContext, changes: KnowledgeChange[]): Promise<KnowledgeChangeView[]> {
  const jobIds = [
    ...new Set(
      changes.filter((change) => change.cause === "source_sync" && change.jobId).map((change) => change.jobId!)
    )
  ];
  if (jobIds.length === 0) {
    return changes;
  }

  const counts = new Map(
    await Promise.all(
      jobIds.map(async (jobId) => [jobId, await sourceSyncService.resolveUpstreamFileCounts(ctx, jobId)] as const)
    )
  );

  return changes.map((change) => {
    const upstream = change.jobId ? counts.get(change.jobId) : undefined;
    return upstream ? { ...change, upstream } : change;
  });
}

/**
 * Which flow a documentId belongs to, for authorizing a per-document timeline.
 * The index is the first answer; a document the log remembers but the index no
 * longer holds (it was removed — precisely the case a change log exists for)
 * falls back to the flow stamped on its own entries. `known: false` means neither
 * knows it, which the route reports as a 404.
 */
export async function resolveDocumentFlow(
  ctx: AppContext,
  documentId: string
): Promise<{ known: boolean; flowId?: string }> {
  const document = ctx.stores.knowledgeIndex.getDocument(documentId);
  if (document) {
    const flow = ctx.knowledgeConfig.flows.find((candidate) => candidate.destinationId === document.repositoryId);
    return { known: true, ...(flow ? { flowId: flow.id } : {}) };
  }

  const [latest] = await ctx.stores.knowledgeChanges.list({ documentId, limit: 1, offset: 0 });
  if (!latest) {
    return { known: false };
  }
  return { known: true, ...(latest.flowId ? { flowId: latest.flowId } : {}) };
}

export function stats(ctx: AppContext): ReturnType<AppContext["stores"]["knowledgeIndex"]["getStats"]> {
  return ctx.stores.knowledgeIndex.getStats();
}

// The configured flows a caller can pin a question to (via /ask `flow`). Exposed
// at read:knowledge so MCP clients can discover ids without the admin /config
// scope. Only id and name leak — personas/sources/destinations stay internal.
export function listFlows(ctx: AppContext): Array<{ id: string; name: string }> {
  return ctx.knowledgeConfig.flows.map((flow) => ({ id: flow.id, name: flow.name }));
}
