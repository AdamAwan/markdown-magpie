import type { DedupeDocumentsJobInput } from "@magpie/core";
import type { AppContext } from "../context.js";
import { dedupeNeighbours } from "./dedupe-neighbours.js";
import { logger } from "../logger.js";

// Runs the dedupe check for one document. The default implementation (in the patrol
// service) enqueues a dedupe_documents AI job; tests inject a spy/fake. Enqueue-only:
// the job detects the duplicate AND produces the changeset, and the corrective
// proposal is drafted later, on job completion (createDedupeProposalFromCompletedJob).
export type DedupeDocumentFn = (ctx: AppContext, input: DedupeDocumentsJobInput) => Promise<void>;

// Runs the dedupe lens over the selected documents: for each, find its k nearest
// neighbours and — when any clear the similarity bar — enqueue ONE dedupe_documents
// job carrying them. A document with no close neighbour is skipped silently. A per-doc
// failure is logged and skipped so one bad doc never aborts the tick. Returns the
// number of scans enqueued.
export async function runDedupeLens(
  ctx: AppContext,
  input: {
    flowId: string | undefined;
    documents: Array<{ path: string; content: string; repositoryId: string }>;
    repositoryIds: string[] | undefined;
    dedupeDocument: DedupeDocumentFn;
  }
): Promise<number> {
  let enqueued = 0;
  for (const document of input.documents) {
    try {
      const neighbours = await dedupeNeighbours(
        ctx,
        { path: document.path, content: document.content },
        input.repositoryIds
      );
      if (neighbours.length === 0) {
        continue;
      }
      await input.dedupeDocument(ctx, {
        path: document.path,
        content: document.content,
        neighbours,
        destinationId: document.repositoryId,
        flowId: input.flowId
      });
      enqueued += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "dedupe failed";
      logger.warn({ path: document.path, err: message }, "dedupe lens: skipping document");
    }
  }
  return enqueued;
}
