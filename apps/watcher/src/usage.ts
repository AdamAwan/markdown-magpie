import type { AiUsage, ChatProvider } from "@magpie/core";

// Job-level token-usage accounting (#241). A job may invoke the provider many
// times (routing, search rounds, grounding verification, critic passes, the
// source-agent tool loop), so per-call usage is summed into one AiUsage that
// rides the job's completion. Everything here is best-effort: a provider that
// reports nothing contributes nothing, and a job with no reported usage
// completes without a usage field at all.

// Sums two optional usage readings field-by-field. A field is present on the
// sum when at least one side reported it, so a provider that reports only
// totals (or only input/output) still accumulates faithfully.
export function addAiUsage(a: AiUsage | undefined, b: AiUsage | undefined): AiUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const inputTokens = sum(a.inputTokens, b.inputTokens);
  const outputTokens = sum(a.outputTokens, b.outputTokens);
  const totalTokens = sum(a.totalTokens, b.totalTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

// Wraps a ChatProvider so every completion's reported usage is forwarded to
// `onUsage` before the response is returned. The runner wraps its provider
// once per job run; the worker loop owns the accumulator.
export function withUsageReporting(provider: ChatProvider, onUsage: (usage: AiUsage) => void): ChatProvider {
  return {
    complete: async (request) => {
      const response = await provider.complete(request);
      if (response.usage) {
        onUsage(response.usage);
      }
      return response;
    }
  };
}

// Maps the AI SDK's LanguageModelUsage (generateText's `totalUsage`) onto
// AiUsage. The SDK types every field as possibly-undefined (and NaN shows up
// for providers that don't report), so each is validated independently.
export function usageFromLanguageModelUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): AiUsage | undefined {
  const clean = (value: number | undefined): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const inputTokens = clean(usage.inputTokens);
  const outputTokens = clean(usage.outputTokens);
  const totalTokens = clean(usage.totalTokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}
