import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmbeddingProvider } from "@magpie/core";
import { BackgroundEmbedder } from "./background-embedder.js";
import type { EmbeddingPersistence } from "../stores/knowledge-index.js";

describe("BackgroundEmbedder", () => {
  it("re-runs a pass that failed on an outage, without waiting for the next re-index", async () => {
    const saved = new Set<string>();
    const store: EmbeddingPersistence = {
      async listSectionsNeedingEmbedding() {
        return saved.has("a") ? [] : [{ id: "a", text: "alpha" }];
      },
      async countSectionsNeedingEmbedding() {
        return saved.has("a") ? 0 : 1;
      },
      async saveSectionEmbedding(id) {
        saved.add(id);
      },
      async saveSectionEmbeddings(entries) {
        for (const entry of entries) {
          saved.add(entry.id);
        }
      },
      async markSectionsEmbeddingSkipped() {}
    };
    let calls = 0;
    const provider: EmbeddingProvider = {
      async embed(texts) {
        calls += 1;
        if (calls === 1) {
          throw new Error("connect ECONNREFUSED");
        }
        return texts.map(() => new Array<number>(1536).fill(0));
      }
    };
    const embedder = new BackgroundEmbedder(store, provider, {
      initialRetryDelayMs: 5,
      retry: { maxAttempts: 1 }
    });

    await embedder.trigger();
    assert.equal(saved.size, 0, "the first pass failed");
    // The retry timer is unref'd; poll on a ref'd one to keep the loop alive.
    for (let tick = 0; tick < 200 && saved.size === 0; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(saved.has("a"), "the scheduled retry embedded the section");
    embedder.stop();
  });
});
