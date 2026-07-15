// Shared label formatters for the Insights chart components, so sibling cards
// on the page can never drift apart in axis formatting.

// Humanise a snake_case key ("correctness_patrol" → "Correctness patrol") for
// an axis label — used for job types, task types, and error categories.
export function humanise(key: string): string {
  const spaced = key.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Short axis label for a time bucket's ISO start ("2026-06-01T00:00:00Z" → "Jun 1").
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Currency-agnostic cost formatter for the AI-cost charts. AI_PRICING rates carry
// no currency symbol (an openai-compatible endpoint could bill in any currency,
// or nothing), so cost is a bare number the operator reads in their own unit.
// Small costs need more decimals than large ones so a fraction of a cent is not
// rendered as "0".
export function formatCost(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2
  });
}
