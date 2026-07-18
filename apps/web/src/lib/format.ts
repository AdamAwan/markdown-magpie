export function shortSha(value: string | undefined): string {
  return value ? value.slice(0, 12) : "Unknown";
}

export function formatQuestionCount(count: number): string {
  return `${count} question${count === 1 ? "" : "s"}`;
}

// React doesn't sanitize `href` — a `javascript:` or `data:` URL would run as a
// clickable link. Server-sourced URLs (e.g. GitHub's html_url) are trusted today,
// but this is cheap defense-in-depth so only navigable http(s) links ever render
// as anchors.
export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
