import { aiUsageFromTokenCounts, type ChatProvider, type ChatRequest, type ChatResponse } from "@magpie/core";
import {
  assertProviderResponseOk,
  DEFAULT_CHAT_RETRY_POLICY,
  DEFAULT_CHAT_TIMEOUT_MS,
  fetchWithTimeout,
  ProviderOutputTruncatedError,
  withProviderRetry,
  type RetryHooks,
  type RetryPolicy
} from "./http.js";

export type ChatProviderName = "openai-compatible" | "azure-openai";

/** Sampling temperature used when a config leaves `temperature` unset. */
export const DEFAULT_CHAT_TEMPERATURE = 0.2;

export interface ChatProviderConfig {
  provider: ChatProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
  timeoutMs?: number;
  /**
   * `undefined` sends DEFAULT_CHAT_TEMPERATURE; a number overrides it; `null`
   * omits the field entirely. Omission is what reasoning deployments
   * (GPT-5-class, o-series) need — they accept only their own default and
   * reject any explicit value with HTTP 400 (#364). Deployment names are
   * operator-chosen, so this is configuration, never a name heuristic.
   */
  temperature?: number | null;
  /**
   * Bounded retry for a transient provider failure (429, 408, 5xx, timeout,
   * dropped connection), honouring Retry-After. Defaults to
   * DEFAULT_CHAT_RETRY_POLICY; `maxRetries: 0` disables it.
   */
  retry?: Partial<RetryPolicy>;
  /** Observes retries (the watcher logs them) and lets tests stub the wait. */
  retryHooks?: RetryHooks;
}

// Per-provider retry settings, resolved once at construction.
interface ChatRetryOptions {
  retry?: Partial<RetryPolicy>;
  retryHooks?: RetryHooks;
}

const LABEL = "Chat provider";

// Conditional spread so `null` contributes no key at all, matching the idiom
// used for the optional embedding `authorization` header.
function temperatureField(temperature: number | null | undefined): { temperature: number } | Record<string, never> {
  const resolved = temperature === undefined ? DEFAULT_CHAT_TEMPERATURE : temperature;
  return resolved === null ? {} : { temperature: resolved };
}

export class OpenAICompatibleChatProvider implements ChatProvider {
  constructor(
    private readonly config: Required<Pick<ChatProviderConfig, "apiKey" | "baseUrl" | "model">> &
      Pick<ChatProviderConfig, "temperature">,
    private readonly timeoutMs: number = DEFAULT_CHAT_TIMEOUT_MS,
    private readonly retryOptions: ChatRetryOptions = {}
  ) {}

  complete(request: ChatRequest): Promise<ChatResponse> {
    return completeWithRetry(this.retryOptions, request.signal, () => this.attempt(request));
  }

  private async attempt(request: ChatRequest): Promise<ChatResponse> {
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
          messages: [{ role: "system", content: request.system }, ...request.messages],
          ...temperatureField(this.config.temperature),
          ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {})
        })
      },
      this.timeoutMs,
      LABEL,
      request.signal
    );

    return parseChatCompletionResponse(response);
  }
}

export class AzureOpenAIChatProvider implements ChatProvider {
  constructor(
    private readonly config: Required<
      Pick<ChatProviderConfig, "apiKey" | "azureEndpoint" | "azureDeployment" | "azureApiVersion">
    > &
      Pick<ChatProviderConfig, "temperature">,
    private readonly timeoutMs: number = DEFAULT_CHAT_TIMEOUT_MS,
    private readonly retryOptions: ChatRetryOptions = {}
  ) {}

  complete(request: ChatRequest): Promise<ChatResponse> {
    return completeWithRetry(this.retryOptions, request.signal, () => this.attempt(request));
  }

  private async attempt(request: ChatRequest): Promise<ChatResponse> {
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
          messages: [{ role: "system", content: request.system }, ...request.messages],
          ...temperatureField(this.config.temperature),
          ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {})
        })
      },
      this.timeoutMs,
      LABEL,
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
        model: config.model,
        ...(config.temperature === undefined ? {} : { temperature: config.temperature })
      },
      config.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
      retryOptionsOf(config)
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
        azureApiVersion: config.azureApiVersion ?? "2024-10-21",
        ...(config.temperature === undefined ? {} : { temperature: config.temperature })
      },
      config.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
      retryOptionsOf(config)
    );
  }

  throw new Error(`Unsupported chat provider: ${String(config.provider)}`);
}

function retryOptionsOf(config: ChatProviderConfig): ChatRetryOptions {
  return {
    ...(config.retry ? { retry: config.retry } : {}),
    ...(config.retryHooks ? { retryHooks: config.retryHooks } : {})
  };
}

// One logical completion: the attempt, retried on a transient provider failure
// within the bounded policy (docs/ai-jobs.md J81). The caller's signal stops
// both the in-flight attempt and any wait between attempts.
function completeWithRetry(
  options: ChatRetryOptions,
  signal: AbortSignal | undefined,
  attempt: () => Promise<ChatResponse>
): Promise<ChatResponse> {
  const policy: RetryPolicy = { ...DEFAULT_CHAT_RETRY_POLICY, ...options.retry };
  return withProviderRetry(attempt, policy, signal, options.retryHooks);
}

async function parseChatCompletionResponse(response: Response): Promise<ChatResponse> {
  // A non-2xx throws a typed ProviderRequestError (status + Retry-After) whose
  // message carries only a short redacted summary of the body (J82).
  await assertProviderResponseOk(response, LABEL);

  const body = (await response.json()) as {
    choices?: Array<{
      finish_reason?: unknown;
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
  // A reply cut off at the output-token limit is a prefix of an answer, never an
  // answer: fail it as a distinct truncation (J83) before anything parses it.
  if (body.choices?.[0]?.finish_reason === "length") {
    const outputTokens = body.usage?.completion_tokens;
    throw new ProviderOutputTruncatedError(
      LABEL,
      typeof outputTokens === "number"
        ? `finish_reason "length" after ${outputTokens} output tokens`
        : 'finish_reason "length"'
    );
  }
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Chat provider returned no message content");
  }

  // Surface the OpenAI-style usage block when the provider sent one (#241).
  // Best-effort: a missing or malformed block simply yields no usage.
  // aiUsageFromTokenCounts is the shared validation point — it also rounds, so
  // a fractional count from a non-conforming gateway can never reach (and be
  // rejected by) the API's integer-only completion contract.
  const usage =
    body.usage && typeof body.usage === "object"
      ? aiUsageFromTokenCounts({
          inputTokens: body.usage.prompt_tokens,
          outputTokens: body.usage.completion_tokens,
          totalTokens: body.usage.total_tokens
        })
      : undefined;
  return usage ? { content, usage } : { content };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertConfig(value: string | undefined, name: string): asserts value is string {
  if (!value) {
    throw new Error(`${name} is required for the selected chat provider`);
  }
}
