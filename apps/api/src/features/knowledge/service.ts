import type { DocumentSection } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { resolveIndexSelection } from "../../platform/repositories.js";

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

  if (message.includes("cannot_be_checked_out") || message.includes("repository_url_required") || message === "configured_repository_not_indexable") {
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

export function stats(ctx: AppContext): ReturnType<AppContext["stores"]["knowledgeIndex"]["getStats"]> {
  return ctx.stores.knowledgeIndex.getStats();
}

// The configured flows a caller can pin a question to (via /ask `flow`). Exposed
// at read:knowledge so MCP clients can discover ids without the admin /config
// scope. Only id and name leak — personas/sources/destinations stay internal.
export function listFlows(ctx: AppContext): Array<{ id: string; name: string }> {
  return ctx.knowledgeConfig.flows.map((flow) => ({ id: flow.id, name: flow.name }));
}
