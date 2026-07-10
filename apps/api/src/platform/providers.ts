import { AI_PROVIDERS, type AiProviderName } from "@magpie/jobs";
import { createEmbeddingProvider, type EmbeddingProviderName } from "@magpie/retrieval";
import { storeBackend } from "./stores.js";
import type { AppConfig } from "./config.js";

export type { AiProviderName } from "@magpie/jobs";

// Embeddings can target a different endpoint/key than chat (e.g. DeepSeek for
// Q&A, OpenAI for embeddings). The dedicated OPENAI_COMPATIBLE_EMBEDDING_* vars
// take precedence, falling back to the shared chat credentials when unset so
// single-endpoint setups keep working unchanged.
function embeddingBaseUrl(config: AppConfig): string | undefined {
  const oai = config.embeddings.openAiCompatible;
  return oai.embeddingBaseUrl || oai.baseUrl || undefined;
}

function embeddingApiKey(config: AppConfig): string | undefined {
  const oai = config.embeddings.openAiCompatible;
  return oai.embeddingApiKey || oai.apiKey || undefined;
}

export function embeddingProviderName(config: AppConfig): EmbeddingProviderName | undefined {
  const oai = config.embeddings.openAiCompatible;
  const azure = config.embeddings.azureOpenAi;
  if (embeddingBaseUrl(config) && embeddingApiKey(config) && oai.embeddingModel) {
    return "openai-compatible";
  }
  if (azure.endpoint && azure.apiKey && azure.embeddingDeployment) {
    return "azure-openai";
  }
  return undefined;
}

// Identity of the configured embedding model, stamped onto section vectors so a
// model change re-embeds instead of silently mixing incompatible vectors. The
// provider name is part of the identity because the model string alone is not
// unique across providers (Azure identifies models by operator-chosen deployment
// name — the closest stable identity Azure exposes). Undefined when embeddings
// are not configured.
export function embeddingModelId(config: AppConfig): string | undefined {
  const provider = embeddingProviderName(config);
  if (provider === "openai-compatible") {
    return `openai-compatible:${config.embeddings.openAiCompatible.embeddingModel}`;
  }
  if (provider === "azure-openai") {
    return `azure-openai:${config.embeddings.azureOpenAi.embeddingDeployment}`;
  }
  return undefined;
}

export function createConfiguredEmbeddingProvider(config: AppConfig) {
  const provider = embeddingProviderName(config);
  if (!provider) {
    return undefined;
  }
  const oai = config.embeddings.openAiCompatible;
  const azure = config.embeddings.azureOpenAi;
  return createEmbeddingProvider({
    provider,
    apiKey: embeddingApiKey(config) || azure.apiKey,
    baseUrl: embeddingBaseUrl(config),
    model: oai.embeddingModel,
    azureEndpoint: azure.endpoint,
    azureDeployment: azure.embeddingDeployment,
    azureApiVersion: azure.apiVersion,
    timeoutMs: config.embeddings.timeoutMs
  });
}

export function retrievalMode(config: AppConfig): { mode: "hybrid" | "keyword"; reason: string } {
  const hasEmbeddings = embeddingProviderName(config) !== undefined;
  const postgres = storeBackend(config, "KNOWLEDGE_STORE") === "postgres";
  if (hasEmbeddings && postgres) {
    return { mode: "hybrid", reason: "Semantic + keyword search active." };
  }
  if (!hasEmbeddings) {
    return { mode: "keyword", reason: "Add an embeddings endpoint to enable semantic search." };
  }
  return { mode: "keyword", reason: "Semantic search requires the Postgres knowledge store (KNOWLEDGE_STORE=postgres)." };
}

// The selectable AI providers in the queue-only world. The API never runs AI
// inline and does not hold provider credentials — watchers do — so this is the
// fixed set of watcher-supported providers rather than something inferred from
// the API's own environment. A watcher only picks up jobs for the provider it is
// actually configured for.
const PROVIDER_LABELS: Record<AiProviderName, string> = {
  "openai-compatible": "OpenAI-compatible",
  "azure-openai": "Azure OpenAI",
  codex: "Codex CLI",
  claude: "Claude CLI"
};

export function getConfiguredAiProviders(): Array<{ name: AiProviderName; label: string }> {
  return AI_PROVIDERS.map((name) => ({ name, label: PROVIDER_LABELS[name] }));
}
