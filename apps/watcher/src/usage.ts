import type { AiUsage, ChatProvider } from "@magpie/core";

// Job-level token-usage accounting (#241). A job may invoke the provider many
// times (routing, search rounds, grounding verification, critic passes, the
// source-agent tool loop), so per-call usage is summed into one AiUsage that
// rides the job's completion. Everything here is best-effort: a provider that
// reports nothing contributes nothing, and a job with no reported usage
// completes without a usage field at all.

// Sums two optional usage readings field-by-field. A field is present on the
// sum when at least one side reported it, so a provider that reports only
// totals (or only input/output) still accumulates faithfully. Totals are
// summed via each side's EFFECTIVE total — the reported totalTokens, or
// input+output when a side reported those without a total — so a run mixing
// calls that report totals with calls that do not can never persist a
// totalTokens smaller than the spend its own input/output fields prove.
export function addAiUsage(a: AiUsage | undefined, b: AiUsage | undefined): AiUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const inputTokens = sum(a.inputTokens, b.inputTokens);
  const outputTokens = sum(a.outputTokens, b.outputTokens);
  const totalTokens = sum(effectiveTotal(a), effectiveTotal(b));
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

// A reading's effective total: what it reported, or what its input/output
// fields add up to when no total was reported. Undefined only when the
// reading carries no counts at all (which addAiUsage's early returns handle).
function effectiveTotal(usage: AiUsage): number | undefined {
  if (usage.totalTokens !== undefined) {
    return usage.totalTokens;
  }
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return undefined;
  }
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
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
