import type { AppContext } from "../../context.js";
import { resolveIndexSelection } from "../../platform/repositories.js";
import { normalizeUploadPath } from "../../platform/paths.js";

export function knowledgeRepositoryErrorCode(message: string): string {
  if (message === "local_path_required") {
    return "local_path_required";
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

export interface UploadDocumentInput {
  path?: string;
  content?: string;
}

export interface UploadDocumentsPayload {
  repositoryId?: string;
  name?: string;
  documents: Array<{ path: string; content: string }>;
}

/**
 * Normalises the incoming documents (path + non-empty content). The handler is
 * responsible for the empty-list (400) and too-large (413) validation so that
 * response shapes and status codes are preserved exactly.
 */
export function normalizeUploadDocuments(
  documents: UploadDocumentInput[] | undefined
): Array<{ path: string; content: string }> {
  return (documents ?? [])
    .map((document) => ({
      path: normalizeUploadPath(document.path),
      content: document.content ?? ""
    }))
    .filter((document) => document.path && document.content.trim());
}

export async function uploadDocuments(
  ctx: AppContext,
  payload: UploadDocumentsPayload
): Promise<Awaited<ReturnType<AppContext["stores"]["knowledgeIndex"]["indexMarkdownDocuments"]>>> {
  const summary = await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    repositoryId: payload.repositoryId?.trim() || "uploaded",
    name: payload.name?.trim() || "Uploaded Markdown",
    documents: payload.documents.map((document) => ({
      path: document.path,
      content: document.content
    }))
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

export function listRepositories(ctx: AppContext): ReturnType<AppContext["stores"]["knowledgeIndex"]["listRepositories"]> {
  return ctx.stores.knowledgeIndex.listRepositories();
}

export function listDocuments(ctx: AppContext): ReturnType<AppContext["stores"]["knowledgeIndex"]["listDocuments"]> {
  return ctx.stores.knowledgeIndex.listDocuments();
}

export function stats(ctx: AppContext): ReturnType<AppContext["stores"]["knowledgeIndex"]["getStats"]> {
  return ctx.stores.knowledgeIndex.getStats();
}
