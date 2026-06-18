import { ConfiguredKnowledgeFlow, RuntimeConfig } from "./types";

export function extractModelInfo(config: RuntimeConfig | undefined): {
  chatModel?: string;
  chatHost?: string;
  embeddingModel?: string;
  embeddingHost?: string;
} {
  if (!config) return {};

  const result: ReturnType<typeof extractModelInfo> = {};
  const providers = config.providers as Record<string, unknown> | undefined;

  if (providers?.openAiCompatible && typeof providers.openAiCompatible === "object") {
    const compat = providers.openAiCompatible as Record<string, unknown>;
    if (typeof compat.model === "string") {
      result.chatModel = compat.model;
    }
    if (typeof compat.baseUrl === "string") {
      result.chatHost = extractHostFromUrl(compat.baseUrl);
    }
    if (typeof compat.embeddingModel === "string") {
      result.embeddingModel = compat.embeddingModel;
    }
    if (typeof compat.embeddingBaseUrl === "string") {
      result.embeddingHost = extractHostFromUrl(compat.embeddingBaseUrl);
    } else if (typeof compat.baseUrl === "string") {
      // No dedicated embedding endpoint configured: embeddings share the chat
      // host. (We're already in the `embeddingBaseUrl is not a string` branch.)
      result.embeddingHost = extractHostFromUrl(compat.baseUrl);
    }
  }

  if (providers?.azureOpenAi && typeof providers.azureOpenAi === "object") {
    const azure = providers.azureOpenAi as Record<string, unknown>;
    if (typeof azure.chatDeployment === "string") {
      result.chatModel = azure.chatDeployment;
      result.chatHost = "Azure OpenAI";
    }
    if (typeof azure.embeddingDeployment === "string") {
      result.embeddingModel = azure.embeddingDeployment;
      result.embeddingHost = "Azure OpenAI";
    }
  }

  return result;
}

export function extractHostFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    if (hostname.includes("deepseek")) return "DeepSeek";
    if (hostname.includes("openrouter")) return "OpenRouter";
    if (hostname.includes("openai.com")) return "OpenAI";
    if (hostname.includes("anthropic")) return "Anthropic";

    return hostname;
  } catch {
    return url;
  }
}

// Flow id -> display name, so gaps/questions/clusters can be tagged with a
// readable flow rather than the raw id. Shared by the Ask and Gaps pages.
export function knowledgeFlowLabels(config: RuntimeConfig | undefined): Record<string, string> {
  return Object.fromEntries(knowledgeFlows(config).map((flow) => [flow.id, flow.name]));
}

export function knowledgeFlows(config: RuntimeConfig | undefined): ConfiguredKnowledgeFlow[] {
  if (config?.knowledge.flows?.length) {
    return config.knowledge.flows;
  }

  const destinations = config?.knowledge.destinations ?? config?.knowledge.repositories ?? [];
  const sourceIds = (config?.knowledge.sources ?? []).map((source) => source.id);
  return destinations.map((destination) => ({
    id: destination.id,
    name: destination.name,
    sourceIds,
    destinationId: destination.id
  }));
}
