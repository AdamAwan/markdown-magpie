import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmbeddingProvider } from "@magpie/core";
import { embedPendingSections, MAX_EMBED_INPUT_CHARS, truncateForEmbedding } from "./embed-sections.js";
import type { EmbeddingPersistence, SectionToEmbed } from "./knowledge-index.js";

function fakeStore(pending: SectionToEmbed[]): EmbeddingPersistence & {
  saved: Map<string, number[]>;
  skipped: Map<string, string>;
  batchCalls: number[];
} {
  const saved = new Map<string, number[]>();
  const skipped = new Map<string, string>();
  const batchCalls: number[] = [];
  const isPending = (section: SectionToEmbed) => !saved.has(section.id) && !skipped.has(section.id);
  return {
    saved,
    skipped,
    batchCalls,
    async listSectionsNeedingEmbedding(limit) {
      return pending.filter(isPending).slice(0, limit);
    },
    async countSectionsNeedingEmbedding() {
      return pending.filter(isPending).length;
    },
    async markSectionsEmbeddingSkipped(entries) {
      for (const entry of entries) {
        skipped.set(entry.id, entry.reason);
      }
    },
    async saveSectionEmbedding(id, embedding) {
      saved.set(id, embedding);
    },
    async saveSectionEmbeddings(entries) {
      batchCalls.push(entries.length);
      for (const entry of entries) {
        saved.set(entry.id, entry.embedding);
      }
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

  it("saves each provider batch in a single batched call instead of one write per section", async () => {
    const store = fakeStore([
      { id: "a", text: "alpha" },
      { id: "b", text: "beta" },
      { id: "c", text: "gamma" }
    ]);

    await embedPendingSections({ store, provider, batchSize: 2 });

    // 3 sections at batchSize 2 -> two provider/save batches (2 then 1), not
    // three individual saveSectionEmbedding calls.
    assert.deepEqual(store.batchCalls, [2, 1]);
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

  it("stops instead of spinning when the store never clears a section", async () => {
    // A store whose saveSectionEmbedding is a no-op keeps returning the same
    // section on every pass; the stall guard must terminate the loop.
    const stuckStore: EmbeddingPersistence = {
      async listSectionsNeedingEmbedding() {
        return [{ id: "a", text: "alpha" }];
      },
      async countSectionsNeedingEmbedding() {
        return 1;
      },
      async saveSectionEmbedding() {
        // no-op: never clears the pending section
      },
      async saveSectionEmbeddings() {
        // no-op: never clears the pending section
      },
      async markSectionsEmbeddingSkipped() {}
    };

    const result = await embedPendingSections({ store: stuckStore, provider, batchSize: 10 });
    // First pass embeds "a"; the second pass returns only the already-attempted
    // "a", so the loop stops rather than running forever.
    assert.equal(result.embeddedCount, 1);
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

// A provider error shaped like an HTTP failure: a numeric `status` and an
// optional `retryAfterMs`, which is what the embedder reads (IN30).
class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(`Embedding provider failed with ${status}`);
  }
}

function vectorFor(text: string): number[] {
  const v = new Array<number>(1536).fill(0);
  v[0] = text.length;
  return v;
}

// Records every sleep instead of waiting, so backoff is asserted, not endured.
function recordingRetry(): { sleeps: number[]; retry: { baseDelayMs: number; sleep: (ms: number) => Promise<void> } } {
  const sleeps: number[] = [];
  return {
    sleeps,
    retry: {
      baseDelayMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    }
  };
}

describe("embedPendingSections resilience", () => {
  it("truncates an oversized section to the model input cap before sending it", async () => {
    const store = fakeStore([{ id: "big", text: "x".repeat(MAX_EMBED_INPUT_CHARS * 3) }]);
    const sent: number[] = [];
    const measuring: EmbeddingProvider = {
      async embed(texts) {
        sent.push(...texts.map((text) => text.length));
        return texts.map(vectorFor);
      }
    };

    const result = await embedPendingSections({ store, provider: measuring });
    assert.deepEqual(sent, [MAX_EMBED_INPUT_CHARS]);
    assert.equal(result.embeddedCount, 1);
  });

  it("does not split a surrogate pair when truncating", () => {
    const text = `${"a".repeat(MAX_EMBED_INPUT_CHARS - 1)}😀tail`;
    const truncated = truncateForEmbedding(text);
    assert.equal(truncated.length, MAX_EMBED_INPUT_CHARS - 1);
    assert.equal(truncateForEmbedding("short"), "short");
  });

  it("backs off and retries a 429/5xx, honouring Retry-After, then succeeds", async () => {
    const store = fakeStore([{ id: "a", text: "alpha" }]);
    const failures = [new ProviderHttpError(429, 5_000), new ProviderHttpError(503)];
    const flaky: EmbeddingProvider = {
      async embed(texts) {
        const failure = failures.shift();
        if (failure) {
          throw failure;
        }
        return texts.map(vectorFor);
      }
    };
    const { sleeps, retry } = recordingRetry();

    const result = await embedPendingSections({ store, provider: flaky, retry });
    assert.equal(result.embeddedCount, 1);
    // First retry waits the provider's Retry-After (above the 100 ms backoff);
    // the second waits the doubled backoff.
    assert.deepEqual(sleeps, [5_000, 200]);
  });

  it("isolates a section the provider rejects, skips it, and embeds the rest", async () => {
    const sections = ["a", "b", "poison", "c", "d"].map((id) => ({ id, text: id }));
    const store = fakeStore(sections);
    const picky: EmbeddingProvider = {
      async embed(texts) {
        if (texts.includes("poison")) {
          throw new ProviderHttpError(400);
        }
        return texts.map(vectorFor);
      }
    };
    const { retry } = recordingRetry();

    const result = await embedPendingSections({ store, provider: picky, batchSize: 10, retry });
    assert.equal(result.embeddedCount, 4);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.remaining, 0);
    assert.deepEqual([...store.saved.keys()].sort(), ["a", "b", "c", "d"]);
    assert.match(store.skipped.get("poison") ?? "", /400/);
  });

  it("isolates a rejected section even when the provider exposes no status", async () => {
    // Today's HTTP providers throw a plain Error, so the failure is treated as
    // transient (retried) — and still isolated once part of the batch embeds.
    const sections = ["a", "poison", "b"].map((id) => ({ id, text: id }));
    const store = fakeStore(sections);
    const picky: EmbeddingProvider = {
      async embed(texts) {
        if (texts.includes("poison")) {
          throw new Error("Embedding provider failed with 400: input too long");
        }
        return texts.map(vectorFor);
      }
    };
    const { retry } = recordingRetry();

    const result = await embedPendingSections({ store, provider: picky, batchSize: 10, retry });
    assert.equal(result.embeddedCount, 2);
    assert.deepEqual([...store.skipped.keys()], ["poison"]);
  });

  it("skips a lone pending section only on a definite client error", async () => {
    const rejected = fakeStore([{ id: "solo", text: "solo" }]);
    const { retry } = recordingRetry();
    const result = await embedPendingSections({
      store: rejected,
      provider: {
        async embed() {
          throw new ProviderHttpError(400);
        }
      },
      retry
    });
    assert.equal(result.skippedCount, 1);

    // Without a status there is no proof the section is at fault: surface it.
    const unknown = fakeStore([{ id: "solo", text: "solo" }]);
    await assert.rejects(
      embedPendingSections({
        store: unknown,
        provider: {
          async embed() {
            throw new Error("socket hang up");
          }
        },
        retry
      }),
      /socket hang up/
    );
    assert.equal(unknown.skipped.size, 0);
  });

  it("treats a batch where nothing embeds as an outage: rethrows and skips nothing", async () => {
    const store = fakeStore(["a", "b", "c", "d"].map((id) => ({ id, text: id })));
    let calls = 0;
    const down: EmbeddingProvider = {
      async embed() {
        calls += 1;
        throw new ProviderHttpError(503);
      }
    };
    const { retry } = recordingRetry();

    await assert.rejects(embedPendingSections({ store, provider: down, batchSize: 10, retry }), /503/);
    assert.equal(store.skipped.size, 0, "an outage must not mark the corpus as bad sections");
    assert.equal(store.saved.size, 0);
    // The whole batch, then each half, each with the default 4 attempts — not
    // a bisection all the way down.
    assert.equal(calls, 12);
  });

  it("does not bisect a batch that is being rate limited", async () => {
    const store = fakeStore(["a", "b"].map((id) => ({ id, text: id })));
    let calls = 0;
    const limited: EmbeddingProvider = {
      async embed() {
        calls += 1;
        throw new ProviderHttpError(429);
      }
    };
    const { retry } = recordingRetry();

    await assert.rejects(embedPendingSections({ store, provider: limited, retry: { ...retry, maxAttempts: 2 } }));
    assert.equal(calls, 2, "only the retries of the whole batch");
    assert.equal(store.skipped.size, 0);
  });
});
