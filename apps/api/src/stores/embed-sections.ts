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
  // Sections we've already tried to embed. If a pass returns only these, the
  // store isn't clearing them (e.g. saveSectionEmbedding silently no-ops), so we
  // stop rather than spin forever — the previous "embeddedThisPass === 0" guard
  // could never fire, since pending.length === 0 already breaks above.
  const attempted = new Set<string>();

  for (;;) {
    const pending = await options.store.listSectionsNeedingEmbedding(batchSize, options.repositoryId);
    if (pending.length === 0) {
      break;
    }
    if (pending.every((section) => attempted.has(section.id))) {
      break;
    }

    const vectors = await options.provider.embed(pending.map((section) => section.text));
    if (vectors.length !== pending.length) {
      throw new Error(
        `Embedding provider returned ${vectors.length} vector(s) for ${pending.length} section(s); refusing to embed a mismatched batch`
      );
    }

    for (const section of pending) {
      attempted.add(section.id);
    }
    // One multi-row write per provider batch instead of one round-trip per
    // section (the original loop awaited saveSectionEmbedding sequentially).
    await options.store.saveSectionEmbeddings(pending.map((section, i) => ({ id: section.id, embedding: vectors[i] })));
    embeddedCount += pending.length;
  }

  const remaining = await options.store.countSectionsNeedingEmbedding(options.repositoryId);
  return { embeddedCount, remaining };
}
