import type { EmbeddingProvider } from "@magpie/core";
import { DEFAULT_EMBEDDING_TIMEOUT_MS, fetchWithTimeout } from "./http.js";

export const EMBEDDING_DIMENSIONS = 1536;

export type EmbeddingProviderName = "openai-compatible" | "azure-openai";

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
  // Opt-in output width for models that support shortening natively
  // (text-embedding-3-small / -large). Sent as the `dimensions` request
  // parameter only when set: ada-002 and many OpenAI-compatible servers —
  // including the Ollama sidecar this repo ships — reject the field outright,
  // so the default has to remain "don't send it".
  dimensions?: number;
  timeoutMs?: number;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(
    // apiKey is optional: unauthenticated OpenAI-compatible embedding servers are
    // common (a local sidecar, an internal service on a trusted network), and
    // sending a credential such an endpoint ignores was never meaningful.
    private readonly config: Required<Pick<EmbeddingProviderConfig, "baseUrl" | "model">> &
      Pick<EmbeddingProviderConfig, "apiKey" | "dimensions">,
    private readonly timeoutMs: number = DEFAULT_EMBEDDING_TIMEOUT_MS
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetchWithTimeout(
      `${trimTrailingSlash(this.config.baseUrl)}/embeddings`,
      {
        method: "POST",
        headers: {
          // Omitted entirely when unset — never sent as "Bearer undefined".
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.model,
          input: texts,
          // Omitted entirely when unset — servers that don't know the field reject it.
          ...(this.config.dimensions === undefined ? {} : { dimensions: this.config.dimensions })
        })
      },
      this.timeoutMs,
      "Embedding provider"
    );

    return parseEmbeddingResponse(response, texts.length);
  }
}

export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly config: Required<
      Pick<EmbeddingProviderConfig, "apiKey" | "azureEndpoint" | "azureDeployment" | "azureApiVersion">
    > &
      Pick<EmbeddingProviderConfig, "dimensions">,
    private readonly timeoutMs: number = DEFAULT_EMBEDDING_TIMEOUT_MS
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const endpoint = trimTrailingSlash(this.config.azureEndpoint);
    const deployment = encodeURIComponent(this.config.azureDeployment);
    const apiVersion = encodeURIComponent(this.config.azureApiVersion);
    const response = await fetchWithTimeout(
      `${endpoint}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`,
      {
        method: "POST",
        headers: {
          "api-key": this.config.apiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: texts,
          // Omitted entirely when unset — ada-002 deployments reject the field.
          ...(this.config.dimensions === undefined ? {} : { dimensions: this.config.dimensions })
        })
      },
      this.timeoutMs,
      "Embedding provider"
    );

    return parseEmbeddingResponse(response, texts.length);
  }
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  if (config.provider === "openai-compatible") {
    assertConfig(config.baseUrl, "OPENAI_COMPATIBLE_BASE_URL");
    assertConfig(config.model, "OPENAI_COMPATIBLE_EMBEDDING_MODEL");
    return new OpenAICompatibleEmbeddingProvider(
      {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions })
      },
      config.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS
    );
  }

  if (config.provider === "azure-openai") {
    assertConfig(config.apiKey, "AZURE_OPENAI_API_KEY");
    assertConfig(config.azureEndpoint, "AZURE_OPENAI_ENDPOINT");
    assertConfig(config.azureDeployment, "AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
    return new AzureOpenAIEmbeddingProvider(
      {
        apiKey: config.apiKey,
        azureEndpoint: config.azureEndpoint,
        azureDeployment: config.azureDeployment,
        azureApiVersion: config.azureApiVersion ?? "2024-10-21",
        ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions })
      },
      config.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS
    );
  }

  throw new Error(`Unsupported embedding provider: ${String(config.provider)}`);
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

  // Reorder by the provider's `index` only when every entry carries one.
  // Defaulting a missing index to 0 (the previous behaviour) would collapse all
  // un-indexed entries to the front and silently misalign vectors with their
  // input text; if indices are absent/partial we trust the returned array order
  // (OpenAI-compatible APIs return embeddings in input order).
  const ordered = [...data];
  if (ordered.every((entry) => typeof entry.index === "number")) {
    ordered.sort((left, right) => (left.index as number) - (right.index as number));
  }

  return ordered.map((entry) => {
    const vector = entry.embedding;
    if (!vector || vector.length === 0) {
      throw new Error("Embedding provider returned an empty vector");
    }
    if (vector.length > EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding provider returned a ${vector.length}-dim vector; the store holds ${EMBEDDING_DIMENSIONS} dimensions. ` +
          `Set AZURE_OPENAI_EMBEDDING_DIMENSIONS or OPENAI_COMPATIBLE_EMBEDDING_DIMENSIONS to ${EMBEDDING_DIMENSIONS} — ` +
          `the text-embedding-3-* models shorten their output natively at full quality. ` +
          `Otherwise choose a model with at most ${EMBEDDING_DIMENSIONS} dimensions.`
      );
    }
    return padToStoredDimensions(vector);
  });
}

// Vectors are stored in a fixed-width pgvector column, but good local models emit
// 384 or 768 dimensions. Zero-padding to the stored width is exact, not an
// approximation: appended zeros contribute nothing to a dot product and nothing to
// either vector's norm, so cosine similarity — and therefore every tuned threshold
// and every ranking — is identical to what the model produces natively.
//
// The alternative, making the column dimension configurable, would fragment the
// schema per deployment, which an append-only migrator with no rollback handles
// badly. The cost here is storage: 2x for a 768-dimension model.
function padToStoredDimensions(vector: number[]): number[] {
  if (vector.length === EMBEDDING_DIMENSIONS) {
    return vector;
  }
  return [...vector, ...new Array<number>(EMBEDDING_DIMENSIONS - vector.length).fill(0)];
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertConfig(value: string | undefined, name: string): asserts value is string {
  if (!value) {
    throw new Error(`${name} is required for the selected embedding provider`);
  }
}
