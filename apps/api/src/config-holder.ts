import { isAiProviderName } from "@magpie/jobs";
import type { AiProviderName } from "./platform/providers.js";

export interface RuntimeAiConfig {
  aiProvider: AiProviderName;
}

export function normalizeAiProvider(value: string | undefined): AiProviderName | undefined {
  return isAiProviderName(value) ? value : undefined;
}

export class RuntimeConfigHolder {
  private config: RuntimeAiConfig;

  constructor(config: RuntimeAiConfig) {
    this.config = config;
  }

  static fromEnv(): RuntimeConfigHolder {
    const aiProvider = normalizeAiProvider(process.env.AI_PROVIDER);
    if (!aiProvider) {
      throw new Error("AI_PROVIDER must name a supported watcher provider");
    }
    return new RuntimeConfigHolder({ aiProvider });
  }

  get(): RuntimeAiConfig {
    return this.config;
  }

  update(next: { aiProvider: AiProviderName }): string | undefined {
    this.config = { aiProvider: next.aiProvider };
    return undefined;
  }

  reset(): void {
    this.config = RuntimeConfigHolder.fromEnv().get();
  }
}
