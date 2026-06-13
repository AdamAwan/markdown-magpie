import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createEmbeddingProvider,
  EMBEDDING_DIMENSIONS,
  OpenAICompatibleEmbeddingProvider
} from "./embeddings.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function vectorOf(length: number): number[] {
  return Array.from({ length }, (_, i) => (i + 1) / length);
}

describe("OpenAICompatibleEmbeddingProvider", () => {
  it("posts inputs to /embeddings and returns vectors ordered by index", async () => {
    let captured: { url: string; body: any } | undefined;
    globalThis.fetch = (async (url: string, init: any) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: vectorOf(EMBEDDING_DIMENSIONS) },
            { index: 0, embedding: vectorOf(EMBEDDING_DIMENSIONS) }
          ]
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "k",
      baseUrl: "https://api.example.com/v1/",
      model: "text-embedding-3-small"
    });
    const vectors = await provider.embed(["first", "second"]);

    assert.equal(captured?.url, "https://api.example.com/v1/embeddings");
    assert.deepEqual(captured?.body.input, ["first", "second"]);
    assert.equal(captured?.body.model, "text-embedding-3-small");
    assert.equal(vectors.length, 2);
    assert.equal(vectors[0].length, EMBEDDING_DIMENSIONS);
  });

  it("throws when a returned vector has the wrong dimension", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(512) }] }), {
        status: 200
      })) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "k",
      baseUrl: "https://api.example.com/v1",
      model: "m"
    });
    await assert.rejects(provider.embed(["x"]), /512-dim vector; expected 1536/);
  });

  it("throws when the response count does not match the input count", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({ apiKey: "k", baseUrl: "u", model: "m" });
    await assert.rejects(provider.embed(["x"]), /returned 0 vectors for 1 inputs/);
  });
});

describe("createEmbeddingProvider", () => {
  it("requires the OpenAI-compatible embedding settings", () => {
    assert.throws(
      () => createEmbeddingProvider({ provider: "openai-compatible", baseUrl: "u", model: "m" }),
      /OPENAI_COMPATIBLE_API_KEY/
    );
  });

  it("falls back to a mock provider with the correct dimensions", async () => {
    const provider = createEmbeddingProvider({ provider: "mock" });
    const [vector] = await provider.embed(["hello"]);
    assert.equal(vector.length, EMBEDDING_DIMENSIONS);
  });
});
