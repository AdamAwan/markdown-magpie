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
  // The env-derived seed (from validated startup config). reset() restores this
  // rather than re-reading the environment, keeping all env access at startup.
  private readonly initial: RuntimeAiConfig;

  constructor(config: RuntimeAiConfig) {
    this.config = config;
    this.initial = config;
  }

  get(): RuntimeAiConfig {
    return this.config;
  }

  update(next: { aiProvider: AiProviderName }): string | undefined {
    this.config = { aiProvider: next.aiProvider };
    return undefined;
  }

  reset(): void {
    this.config = this.initial;
  }
}
