import type { EmbeddingProvider } from "@magpie/core";
import type { EmbeddingPersistence } from "./knowledge-index.js";

export interface EmbedPendingOptions {
  store: EmbeddingPersistence;
  provider: EmbeddingProvider;
  repositoryId?: string;
  batchSize?: number;
}

export interface EmbedPendingResult {
  embeddedCount: number;
  remaining: number;
}

const DEFAULT_BATCH_SIZE = 64;

/**
 * Embeds every section missing an embedding, in batches, idempotently. Only
 * targets sections where the embedding column is NULL, so retries and partial
 * failures are safe and re-indexed (re-inserted) sections are picked up here.
 */
export async function embedPendingSections(options: EmbedPendingOptions): Promise<EmbedPendingResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let embeddedCount = 0;

  for (;;) {
    const pending = await options.store.listSectionsNeedingEmbedding(batchSize, options.repositoryId);
    if (pending.length === 0) {
      break;
    }

    const vectors = await options.provider.embed(pending.map((section) => section.text));
    for (let i = 0; i < pending.length; i += 1) {
      await options.store.saveSectionEmbedding(pending[i].id, vectors[i]);
      embeddedCount += 1;
    }
  }

  const remaining = await options.store.countSectionsNeedingEmbedding(options.repositoryId);
  return { embeddedCount, remaining };
}
