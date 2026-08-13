import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  AzureOpenAIEmbeddingProvider,
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

  it("pads a shorter provider vector to the stored dimension", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(768) }] }), {
        status: 200
      })) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "k",
      baseUrl: "http://localhost:8080/v1",
      model: "BAAI/bge-base-en-v1.5"
    });
    const [vector] = await provider.embed(["hello"]);

    assert.equal(vector.length, EMBEDDING_DIMENSIONS);
    assert.deepEqual(vector.slice(0, 768), vectorOf(768));
    assert.deepEqual(vector.slice(768), new Array(EMBEDDING_DIMENSIONS - 768).fill(0));
  });

  it("throws when a returned vector is wider than the stored dimension", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(3072) }] }), {
        status: 200
      })) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "k",
      baseUrl: "https://api.example.com/v1",
      model: "too-wide"
    });
    await assert.rejects(provider.embed(["x"]), /3072-dim vector.*1536 dimensions/s);
  });

  it("throws when a returned vector is empty", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [] }] }), {
        status: 200
      })) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({ apiKey: "k", baseUrl: "u", model: "m" });
    await assert.rejects(provider.embed(["x"]), /empty vector/);
  });

  it("omits the Authorization header when no API key is configured", async () => {
    let captured: { headers: any } | undefined;
    globalThis.fetch = (async (_url: string, init: any) => {
      captured = { headers: init.headers };
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(768) }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "http://embeddings:80/v1",
      model: "BAAI/bge-base-en-v1.5"
    });
    await provider.embed(["hello"]);

    assert.equal(captured?.headers.authorization, undefined);
  });

  it("sends the Authorization header when an API key is configured", async () => {
    let captured: { headers: any } | undefined;
    globalThis.fetch = (async (_url: string, init: any) => {
      captured = { headers: init.headers };
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(EMBEDDING_DIMENSIONS) }] }), {
        status: 200
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "secret",
      baseUrl: "https://api.example.com/v1",
      model: "text-embedding-3-small"
    });
    await provider.embed(["hello"]);

    assert.equal(captured?.headers.authorization, "Bearer secret");
  });

  it("throws when the response count does not match the input count", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({ apiKey: "k", baseUrl: "u", model: "m" });
    await assert.rejects(provider.embed(["x"]), /returned 0 vectors for 1 inputs/);
  });
});

describe("zero-padding", () => {
  // The property the whole approach rests on: appended zeros add nothing to the
  // dot product and nothing to either norm, so every threshold tuned at 1536
  // behaves identically on a padded 768-dimension vector. Executable
  // justification for the design, not a driver for it.
  it("leaves cosine similarity unchanged", () => {
    const cosine = (x: number[], y: number[]): number => {
      const dot = x.reduce((sum, value, index) => sum + value * y[index], 0);
      const norm = (v: number[]): number => Math.sqrt(v.reduce((sum, value) => sum + value * value, 0));
      return dot / (norm(x) * norm(y));
    };
    const pad = (v: number[]): number[] => [...v, ...new Array<number>(10).fill(0)];
    const a = [3, 4, 0];
    const b = [4, 3, 0];

    assert.equal(cosine(pad(a), pad(b)), cosine(a, b));
  });
});

describe("AzureOpenAIEmbeddingProvider", () => {
  it("posts to the deployment embeddings URL with the api-key header", async () => {
    let captured: { url: string; headers: any; body: any } | undefined;
    globalThis.fetch = (async (url: string, init: any) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(EMBEDDING_DIMENSIONS) }] }), {
        status: 200
      });
    }) as unknown as typeof fetch;

    const provider = new AzureOpenAIEmbeddingProvider({
      apiKey: "secret",
      azureEndpoint: "https://my.openai.azure.com/",
      azureDeployment: "embed-3",
      azureApiVersion: "2024-10-21"
    });
    const vectors = await provider.embed(["only"]);

    assert.equal(
      captured?.url,
      "https://my.openai.azure.com/openai/deployments/embed-3/embeddings?api-version=2024-10-21"
    );
    assert.equal(captured?.headers["api-key"], "secret");
    assert.equal(captured?.headers.authorization, undefined);
    assert.deepEqual(captured?.body.input, ["only"]);
    assert.equal(vectors.length, 1);
  });
});

describe("createEmbeddingProvider", () => {
  it("requires the OpenAI-compatible embedding settings", () => {
    assert.throws(
      () => createEmbeddingProvider({ provider: "openai-compatible", apiKey: "k", baseUrl: "u" }),
      /OPENAI_COMPATIBLE_EMBEDDING_MODEL/
    );
  });

  it("builds an OpenAI-compatible provider without an API key", () => {
    assert.ok(createEmbeddingProvider({ provider: "openai-compatible", baseUrl: "u", model: "m" }));
  });

  it("requires the Azure embedding settings", () => {
    assert.throws(
      () => createEmbeddingProvider({ provider: "azure-openai", apiKey: "k", azureEndpoint: "e" }),
      /AZURE_OPENAI_EMBEDDING_DEPLOYMENT/
    );
  });
});
