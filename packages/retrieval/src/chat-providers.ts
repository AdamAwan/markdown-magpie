import type { ChatProvider, ChatRequest, ChatResponse } from "@magpie/core";
import { DEFAULT_CHAT_TIMEOUT_MS, fetchWithTimeout } from "./http.js";

export type ChatProviderName = "openai-compatible" | "azure-openai";

export interface ChatProviderConfig {
  provider: ChatProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
  timeoutMs?: number;
}

export class OpenAICompatibleChatProvider implements ChatProvider {
  constructor(
    private readonly config: Required<Pick<ChatProviderConfig, "apiKey" | "baseUrl" | "model">>,
    private readonly timeoutMs: number = DEFAULT_CHAT_TIMEOUT_MS
  ) {}

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetchWithTimeout(
      `${trimTrailingSlash(this.config.baseUrl)}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: request.system },
            ...request.messages
          ],
          temperature: 0.2,
          ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {})
        })
      },
      this.timeoutMs,
      "Chat provider",
      request.signal
    );

    return parseChatCompletionResponse(response);
  }
}

export class AzureOpenAIChatProvider implements ChatProvider {
  constructor(
    private readonly config: Required<
      Pick<ChatProviderConfig, "apiKey" | "azureEndpoint" | "azureDeployment" | "azureApiVersion">
    >,
    private readonly timeoutMs: number = DEFAULT_CHAT_TIMEOUT_MS
  ) {}

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const endpoint = trimTrailingSlash(this.config.azureEndpoint);
    const deployment = encodeURIComponent(this.config.azureDeployment);
    const apiVersion = encodeURIComponent(this.config.azureApiVersion);
    const response = await fetchWithTimeout(
      `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
      {
        method: "POST",
        headers: {
          "api-key": this.config.apiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: request.system },
            ...request.messages
          ],
          temperature: 0.2,
          ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {})
        })
      },
      this.timeoutMs,
      "Chat provider",
      request.signal
    );

    return parseChatCompletionResponse(response);
  }
}

export function createChatProvider(config: ChatProviderConfig): ChatProvider {
  if (config.provider === "openai-compatible") {
    assertConfig(config.apiKey, "OPENAI_COMPATIBLE_API_KEY");
    assertConfig(config.baseUrl, "OPENAI_COMPATIBLE_BASE_URL");
    assertConfig(config.model, "OPENAI_COMPATIBLE_MODEL");
    return new OpenAICompatibleChatProvider(
      {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model
      },
      config.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
    );
  }

  if (config.provider === "azure-openai") {
    assertConfig(config.apiKey, "AZURE_OPENAI_API_KEY");
    assertConfig(config.azureEndpoint, "AZURE_OPENAI_ENDPOINT");
    assertConfig(config.azureDeployment, "AZURE_OPENAI_CHAT_DEPLOYMENT");
    return new AzureOpenAIChatProvider(
      {
        apiKey: config.apiKey,
        azureEndpoint: config.azureEndpoint,
        azureDeployment: config.azureDeployment,
        azureApiVersion: config.azureApiVersion ?? "2024-10-21"
      },
      config.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
    );
  }

  throw new Error(`Unsupported chat provider: ${String(config.provider)}`);
}

async function parseChatCompletionResponse(response: Response): Promise<ChatResponse> {
  if (!response.ok) {
    throw new Error(`Chat provider failed with ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
    };
  };
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Chat provider returned no message content");
  }

  // Surface the OpenAI-style usage block when the provider sent one (#241).
  // Best-effort: a missing or malformed block simply yields no usage.
  const usage = parseUsage(body.usage);
  return usage ? { content, usage } : { content };
}

function parseUsage(raw: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } | undefined):
  | ChatResponse["usage"]
  | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const inputTokens = asTokenCount(raw.prompt_tokens);
  const outputTokens = asTokenCount(raw.completion_tokens);
  const totalTokens = asTokenCount(raw.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

function asTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertConfig(value: string | undefined, name: string): asserts value is string {
  if (!value) {
    throw new Error(`${name} is required for the selected chat provider`);
  }
}
