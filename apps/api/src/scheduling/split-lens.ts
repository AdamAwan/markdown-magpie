import type { SplitDocumentJobInput } from "@magpie/core";
import type { AppContext } from "../context.js";
import { splitNeighbours } from "./split-neighbours.js";

const SPLIT_MIN_CHARS = 15_000;
const SPLIT_MIN_H2_COUNT = 6;

export type SplitDocumentFn = (ctx: AppContext, input: SplitDocumentJobInput) => Promise<void>;

export function qualifiesForSplitScan(content: string): boolean {
  const h2Count = content.split(/\r?\n/).filter((line) => /^##\s+\S/.test(line)).length;
  return content.length > SPLIT_MIN_CHARS || h2Count >= SPLIT_MIN_H2_COUNT;
}

export async function runSplitLens(
  ctx: AppContext,
  input: {
    flowId: string | undefined;
    documents: Array<{ path: string; content: string; repositoryId: string }>;
    repositoryIds: string[] | undefined;
    splitDocument: SplitDocumentFn;
  }
): Promise<number> {
  let enqueued = 0;

  for (const document of input.documents) {
    if (!qualifiesForSplitScan(document.content)) continue;

    try {
      const neighbours = await splitNeighbours(
        ctx,
        { path: document.path, content: document.content },
        input.repositoryIds
      );
      await input.splitDocument(ctx, {
        path: document.path,
        content: document.content,
        neighbours,
        destinationId: document.repositoryId,
        flowId: input.flowId
      });
      enqueued += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Split lens: skipping ${document.path} - ${message}.`);
    }
  }

  return enqueued;
}
