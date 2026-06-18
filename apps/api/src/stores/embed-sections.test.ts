import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmbeddingProvider } from "@magpie/core";
import { embedPendingSections } from "./embed-sections.js";
import type { EmbeddingPersistence, SectionToEmbed } from "./knowledge-index.js";

function fakeStore(pending: SectionToEmbed[]): EmbeddingPersistence & { saved: Map<string, number[]> } {
  const saved = new Map<string, number[]>();
  return {
    saved,
    async listSectionsNeedingEmbedding(limit) {
      return pending.filter((s) => !saved.has(s.id)).slice(0, limit);
    },
    async countSectionsNeedingEmbedding() {
      return pending.filter((s) => !saved.has(s.id)).length;
    },
    async saveSectionEmbedding(id, embedding) {
      saved.set(id, embedding);
    }
  };
}

const provider: EmbeddingProvider = {
  async embed(texts) {
    return texts.map((text) => {
      const v = new Array(1536).fill(0);
      v[0] = text.length;
      return v;
    });
  }
};

describe("embedPendingSections", () => {
  it("embeds every pending section across batches and reports counts", async () => {
    const store = fakeStore([
      { id: "a", text: "alpha" },
      { id: "b", text: "beta" },
      { id: "c", text: "gamma" }
    ]);

    const result = await embedPendingSections({ store, provider, batchSize: 2 });

    assert.equal(result.embeddedCount, 3);
    assert.equal(result.remaining, 0);
    assert.equal(store.saved.size, 3);
    assert.equal(store.saved.get("a")?.[0], 5); // "alpha".length
  });

  it("is idempotent — already-embedded sections are not re-embedded", async () => {
    const store = fakeStore([{ id: "a", text: "alpha" }]);
    await store.saveSectionEmbedding("a", new Array(1536).fill(0));

    const result = await embedPendingSections({ store, provider, batchSize: 10 });

    assert.equal(result.embeddedCount, 0);
    assert.equal(result.remaining, 0);
  });

  it("throws (does not infinite-loop) when the provider returns fewer vectors than sections", async () => {
    const store = fakeStore([
      { id: "a", text: "alpha" },
      { id: "b", text: "beta" }
    ]);
    // Provider returns a short array (one vector for two sections).
    const shortProvider: EmbeddingProvider = {
      async embed() {
        return [new Array(1536).fill(0)];
      }
    };

    await assert.rejects(
      () => embedPendingSections({ store, provider: shortProvider, batchSize: 10 }),
      /returned 1 vector\(s\) for 2 section\(s\)/
    );
    // Nothing was persisted because the batch was rejected up front.
    assert.equal(store.saved.size, 0);
  });

  it("throws when the provider returns an empty vector array", async () => {
    const store = fakeStore([{ id: "a", text: "alpha" }]);
    const emptyProvider: EmbeddingProvider = {
      async embed() {
        return [];
      }
    };

    await assert.rejects(() => embedPendingSections({ store, provider: emptyProvider, batchSize: 10 }));
  });
});
