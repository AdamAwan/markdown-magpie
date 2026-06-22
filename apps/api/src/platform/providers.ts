import { AI_PROVIDERS, type AiProviderName } from "@magpie/jobs";
import { createEmbeddingProvider, type EmbeddingProviderName } from "@magpie/retrieval";
import { storeBackend } from "./stores.js";

export type { AiProviderName } from "@magpie/jobs";

// Optional per-call timeout overrides for the model endpoints (the packages
// supply sensible defaults when these are unset). Read here at the composition
// root so the retrieval package stays free of process/env access.
function timeoutOverride(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// Embeddings can target a different endpoint/key than chat (e.g. DeepSeek for
// Q&A, OpenAI for embeddings). The dedicated OPENAI_COMPATIBLE_EMBEDDING_* vars
// take precedence, falling back to the shared chat credentials when unset so
// single-endpoint setups keep working unchanged.
function embeddingBaseUrl(): string | undefined {
  return process.env.OPENAI_COMPATIBLE_EMBEDDING_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL || undefined;
}

function embeddingApiKey(): string | undefined {
  return process.env.OPENAI_COMPATIBLE_EMBEDDING_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || undefined;
}

export function embeddingProviderName(): EmbeddingProviderName | undefined {
  if (embeddingBaseUrl() && embeddingApiKey() && process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL) {
    return "openai-compatible";
  }
  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT) {
    return "azure-openai";
  }
  return undefined;
}

export function createConfiguredEmbeddingProvider() {
  const provider = embeddingProviderName();
  if (!provider) {
    return undefined;
  }
  return createEmbeddingProvider({
    provider,
    apiKey: embeddingApiKey() || process.env.AZURE_OPENAI_API_KEY,
    baseUrl: embeddingBaseUrl(),
    model: process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL,
    azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    azureDeployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    azureApiVersion: process.env.AZURE_OPENAI_API_VERSION,
    timeoutMs: timeoutOverride("EMBEDDING_TIMEOUT_MS")
  });
}

export function retrievalMode(): { mode: "hybrid" | "keyword"; reason: string } {
  const hasEmbeddings = embeddingProviderName() !== undefined;
  const postgres = storeBackend("KNOWLEDGE_STORE") === "postgres";
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
