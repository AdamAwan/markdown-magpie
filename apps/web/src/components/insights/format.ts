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
