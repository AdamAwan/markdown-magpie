import type { AiExecutionMode } from "@magpie/core";
import { getConfiguredAiProviders, type AiProviderName } from "./platform/providers.js";

export interface RuntimeAiConfig {
  aiExecutionMode: AiExecutionMode;
  aiProvider: AiProviderName;
}

export function normalizeAiExecutionMode(value: string | undefined): AiExecutionMode | undefined {
  if (value === "direct" || value === "queue") {
    return value;
  }
  return undefined;
}

export function normalizeAiProvider(value: string | undefined): AiProviderName | undefined {
  if (value === "mock" || value === "openai-compatible" || value === "azure-openai" || value === "codex" || value === "claude") {
    return value;
  }
  return undefined;
}

export function validateRuntimeAiConfig(aiExecutionMode: AiExecutionMode, aiProvider: AiProviderName): string | undefined {
  const configuredProvider = getConfiguredAiProviders().find((provider) => provider.name === aiProvider);
  if (!configuredProvider) {
    return `${aiProvider} is not configured by environment variables`;
  }
  if (aiExecutionMode === "direct" && !configuredProvider.supportsDirect) {
    return `${aiProvider} cannot be used in direct mode`;
  }
  if (aiExecutionMode === "queue" && !configuredProvider.supportsQueue) {
    return `${aiProvider} cannot be used in queue mode`;
  }
  return undefined;
}

export class RuntimeConfigHolder {
  private config: RuntimeAiConfig;

  constructor(config: RuntimeAiConfig) {
    this.config = config;
  }

  static fromEnv(): RuntimeConfigHolder {
    const aiExecutionMode = normalizeAiExecutionMode(process.env.AI_EXECUTION_MODE) ?? "direct";
    const providerFromEnv =
      process.env.AI_PROVIDER ??
      (aiExecutionMode === "queue" ? process.env.AI_JOB_PROVIDER : process.env.CHAT_PROVIDER) ??
      process.env.CHAT_PROVIDER ??
      process.env.AI_JOB_PROVIDER;
    const aiProvider = normalizeAiProvider(providerFromEnv) ?? "mock";
    const validationError = validateRuntimeAiConfig(aiExecutionMode, aiProvider);
    if (validationError) {
      throw new Error(validationError);
    }
    return new RuntimeConfigHolder({ aiExecutionMode, aiProvider });
  }

  get(): RuntimeAiConfig {
    return this.config;
  }

  update(next: { aiExecutionMode: AiExecutionMode; aiProvider: AiProviderName }): string | undefined {
    const error = validateRuntimeAiConfig(next.aiExecutionMode, next.aiProvider);
    if (error) {
      return error;
    }
    this.config = next;
    return undefined;
  }

  reset(): void {
    this.config = RuntimeConfigHolder.fromEnv().get();
  }
}
