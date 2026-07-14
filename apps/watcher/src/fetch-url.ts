import type { SourceDescriptor } from "@magpie/core";
import { logger } from "./logger.js";
import { SourceToolError, type ToolBudget } from "./source-tools.js";

// Bounded https fetching for internet-kind sources (#242). Same philosophy as
// source-tools.ts: string in, rendered string out, SourceToolError on anything
// the model can recover from. Fetched web content is UNTRUSTED input to the
// drafting agent (docs/threat-model.md) — this module only bounds what can be
// reached and how much of it comes back; the human merge review remains the
// backstop for what the content says.
//
// Enforcement is an exact-hostname allowlist the operator configured on the
// source descriptor. There are no wildcards and no scheme other than https, and
// every redirect hop is re-validated against the same allowlist so an
// allowlisted page cannot bounce the agent to an arbitrary host.

// An internet source the operator explicitly opted into fetching by configuring
// a non-empty allowlist. Descriptors without one never reach this module.
export interface FetchableInternetSource {
  sourceId: string;
  name: string;
  url?: string;
  allowedHosts: string[];
}

// Returns the fetchable projection of internet descriptors: only those with a
// non-empty allowlist, hosts normalized for comparison. Shared by both
// execution tiers so "fetchable" means the same thing everywhere.
export function fetchableInternetSources(descriptors: readonly SourceDescriptor[]): FetchableInternetSource[] {
  const fetchable: FetchableInternetSource[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.kind !== "internet") {
      continue;
    }
    const allowedHosts = [
      ...new Set((descriptor.allowedHosts ?? []).map(normalizeHost).filter(Boolean))
    ];
    if (allowedHosts.length === 0) {
      continue;
    }
    fetchable.push({
      sourceId: descriptor.id,
      name: descriptor.name,
      ...(descriptor.url ? { url: descriptor.url } : {}),
      allowedHosts
    });
  }
  return fetchable;
}

// Mirror of read_file's 32KB slice so one page cannot dominate the context.
const FETCH_SLICE_CHARS = 32_000;
// Hard cap on bytes pulled off the wire per URL; the decoded text is further
// trimmed to MAX_TEXT_CHARS before caching.
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
// text/* plus the structured-text application types worth reading.
const TEXT_CONTENT_TYPE = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|rss\+xml|atom\+xml)\b)|[+](?:json|xml)\b/i;

const FETCH_USER_AGENT = "markdown-magpie-source-agent";

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

// Per-job fetcher: caches extracted text per requested URL so offset paging
// re-slices from memory instead of re-hitting the network, and charges every
// returned slice against the same read budget the filesystem tools share.
export class UrlFetcher {
  private readonly allowedHosts: Set<string>;
  private readonly cache = new Map<string, { text: string; finalUrl: string }>();

  constructor(
    sources: FetchableInternetSource[],
    private readonly budget: ToolBudget,
    private readonly options: { signal?: AbortSignal; fetchImpl?: FetchImpl } = {}
  ) {
    this.allowedHosts = new Set(sources.flatMap((source) => source.allowedHosts.map(normalizeHost)));
  }

  async fetch(requested: string, offset = 0): Promise<string> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new SourceToolError(`offset must be a non-negative integer, got ${offset}`);
    }
    if (this.budget.remainingBytes <= 0) {
      throw new SourceToolError("read budget exhausted; answer from what you have already read");
    }
    const cached = this.cache.get(requested) ?? (await this.download(requested));
    this.cache.set(requested, cached);

    const slice = cached.text.slice(offset, offset + Math.min(FETCH_SLICE_CHARS, this.budget.remainingBytes));
    // Chars sliced, bytes budgeted — same soft-cap trade-off as read_file.
    this.budget.remainingBytes -= Buffer.byteLength(slice, "utf8");
    const redirected = cached.finalUrl !== requested ? `[content served from ${cached.finalUrl}]\n` : "";
    const suffix =
      offset + slice.length < cached.text.length
        ? `\n\n[truncated at ${offset + slice.length} of ${cached.text.length} chars; re-call with offset=${offset + slice.length} if needed]`
        : "";
    if (slice.length === 0 && offset > 0) {
      return `[no content at offset ${offset}; the page has ${cached.text.length} chars]`;
    }
    return redirected + slice + suffix;
  }

  // One network retrieval: validate every hop, gate the content type, stream the
  // body under the byte cap, and reduce HTML to readable text.
  private async download(requested: string): Promise<{ text: string; finalUrl: string }> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let current = this.validated(requested);

    for (let hop = 0; ; hop += 1) {
      let response: Response;
      try {
        response = await fetchImpl(current.href, {
          redirect: "manual",
          signal: this.timeoutSignal(),
          headers: { accept: "text/html, text/*;q=0.9, application/json;q=0.8, */*;q=0.1", "user-agent": FETCH_USER_AGENT }
        });
      } catch (error) {
        // Timeouts, DNS failures, refused connections — the model picks another
        // source; the failure is logged as the operator-facing record.
        logger.warn({ url: current.href, err: error instanceof Error ? error.message : String(error) }, "fetch_url: network failure");
        throw new SourceToolError(`fetch failed for ${current.href}: ${error instanceof Error && error.name === "AbortError" ? `timed out after ${FETCH_TIMEOUT_MS}ms` : "network error"}`);
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        // Undici only exposes a manual-redirect body after it is consumed/cancelled.
        await response.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new SourceToolError(`fetch failed for ${current.href}: redirect without a location`);
        }
        if (hop + 1 > MAX_REDIRECTS) {
          throw new SourceToolError(`fetch failed for ${requested}: more than ${MAX_REDIRECTS} redirects`);
        }
        // Every hop passes the same https + allowlist gate as the first.
        current = this.validated(new URL(location, current).href);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        logger.warn({ url: current.href, status: response.status }, "fetch_url: HTTP error status");
        throw new SourceToolError(`fetch failed for ${current.href}: HTTP ${response.status}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !TEXT_CONTENT_TYPE.test(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new SourceToolError(`not a text resource (${contentType.split(";")[0]}): ${current.href}`);
      }

      const raw = await this.readBounded(response, current.href);
      const text = (isHtml(contentType) ? htmlToText(raw) : raw).slice(0, MAX_TEXT_CHARS);
      // The operator-facing audit line the threat model asks for: every
      // successful retrieval is on record with where it went and how much came back.
      logger.info(
        { url: requested, finalUrl: current.href, status: response.status, chars: text.length },
        "fetch_url: fetched internet source"
      );
      return { text, finalUrl: current.href };
    }
  }

  // Parse + https + exact-hostname allowlist. The thrown messages echo only the
  // model-supplied URL, never host internals.
  private validated(candidate: string): URL {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new SourceToolError(`not a valid URL: ${candidate}`);
    }
    if (url.protocol !== "https:") {
      throw new SourceToolError(`only https URLs can be fetched: ${candidate}`);
    }
    const host = normalizeHost(url.hostname);
    if (!this.allowedHosts.has(host)) {
      throw new SourceToolError(
        `host "${host}" is not on the fetch allowlist (allowed: ${[...this.allowedHosts].sort().join(", ")})`
      );
    }
    return url;
  }

  private timeoutSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    return this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
  }

  // Streams the body up to the byte cap; a page that exceeds it fails rather
  // than truncating silently, steering the model to a more specific URL.
  private async readBounded(response: Response, href: string): Promise<string> {
    if (!response.body) {
      return "";
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) {
          throw new SourceToolError(`response exceeds the ${MAX_DOWNLOAD_BYTES}-byte fetch cap: ${href}`);
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isHtml(contentType: string): boolean {
  return /text\/html|application\/xhtml\+xml/i.test(contentType);
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

// Crude, dependency-free HTML→text: drop the invisible subtrees, break on the
// structural tags, strip the rest, decode the entities that matter in prose.
// Good enough for grounding — the agent needs the words, not the layout.
export function htmlToText(html: string): string {
  const withoutInvisible = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutInvisible.replace(
    /<\/(?:p|div|section|article|li|tr|h[1-6]|blockquote|pre|table)\s*>|<br\s*\/?\s*>/gi,
    "\n"
  );
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = stripped
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeFromCodePoint(Number.parseInt(code, 16)));
  return decoded
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n")
    .trim();
}

function safeFromCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}
