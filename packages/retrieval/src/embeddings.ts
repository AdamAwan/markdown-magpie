import type { EmbeddingProvider } from "@magpie/core";

export const EMBEDDING_DIMENSIONS = 1536;

export type EmbeddingProviderName = "mock" | "openai-compatible" | "azure-openai";

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    // Correctly-dimensioned, non-zero, deterministic. Never written to pgvector
    // (hybrid is disabled for the mock provider) — exists only to satisfy the interface.
    return texts.map((text) => {
      const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      vector[0] = text.length || 1;
      return vector;
    });
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly config: Required<Pick<EmbeddingProviderConfig, "apiKey" | "baseUrl" | "model">>) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${trimTrailingSlash(this.config.baseUrl)}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: this.config.model, input: texts })
    });

    return parseEmbeddingResponse(response, texts.length);
  }
}

export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly config: Required<
      Pick<EmbeddingProviderConfig, "apiKey" | "azureEndpoint" | "azureDeployment" | "azureApiVersion">
    >
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const endpoint = trimTrailingSlash(this.config.azureEndpoint);
    const deployment = encodeURIComponent(this.config.azureDeployment);
    const apiVersion = encodeURIComponent(this.config.azureApiVersion);
    const response = await fetch(
      `${endpoint}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`,
      {
        method: "POST",
        headers: {
          "api-key": this.config.apiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({ input: texts })
      }
    );

    return parseEmbeddingResponse(response, texts.length);
  }
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  if (config.provider === "openai-compatible") {
    assertConfig(config.apiKey, "OPENAI_COMPATIBLE_API_KEY");
    assertConfig(config.baseUrl, "OPENAI_COMPATIBLE_BASE_URL");
    assertConfig(config.model, "OPENAI_COMPATIBLE_EMBEDDING_MODEL");
    return new OpenAICompatibleEmbeddingProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model
    });
  }

  if (config.provider === "azure-openai") {
    assertConfig(config.apiKey, "AZURE_OPENAI_API_KEY");
    assertConfig(config.azureEndpoint, "AZURE_OPENAI_ENDPOINT");
    assertConfig(config.azureDeployment, "AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
    return new AzureOpenAIEmbeddingProvider({
      apiKey: config.apiKey,
      azureEndpoint: config.azureEndpoint,
      azureDeployment: config.azureDeployment,
      azureApiVersion: config.azureApiVersion ?? "2024-10-21"
    });
  }

  return new MockEmbeddingProvider();
}

async function parseEmbeddingResponse(response: Response, expectedCount: number): Promise<number[][]> {
  if (!response.ok) {
    throw new Error(`Embedding provider failed with ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };
  const data = body.data ?? [];
  if (data.length !== expectedCount) {
    throw new Error(`Embedding provider returned ${data.length} vectors for ${expectedCount} inputs`);
  }

  return [...data]
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map((entry) => {
      const vector = entry.embedding;
      if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding provider returned a ${vector?.length ?? 0}-dim vector; expected ${EMBEDDING_DIMENSIONS}`
        );
      }
      return vector;
    });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertConfig(value: string | undefined, name: string): asserts value is string {
  if (!value) {
    throw new Error(`${name} is required for the selected embedding provider`);
  }
}
