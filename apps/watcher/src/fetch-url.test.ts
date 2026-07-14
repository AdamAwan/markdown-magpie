import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceDescriptor } from "@magpie/core";
import { fetchableInternetSources, htmlToText, UrlFetcher, type FetchImpl } from "./fetch-url.js";
import { SourceToolError, type ToolBudget } from "./source-tools.js";

const internet = (over: Partial<Extract<SourceDescriptor, { kind: "internet" }>> = {}): SourceDescriptor => ({
  id: "i1",
  name: "Vendor docs",
  kind: "internet",
  url: "https://docs.example.com/start",
  allowedHosts: ["docs.example.com"],
  ...over
});

const budget = (remainingBytes = 400_000): ToolBudget => ({ remainingBytes });

// A scripted fetch: each entry answers one request, in order.
function scriptedFetch(
  responses: Array<{ status?: number; headers?: Record<string, string>; body?: string }>,
  calls: string[] = []
): FetchImpl {
  let index = 0;
  return async (url) => {
    calls.push(url);
    const script = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(script?.body ?? "", {
      status: script?.status ?? 200,
      headers: { "content-type": "text/plain", ...script?.headers }
    });
  };
}

describe("fetchableInternetSources", () => {
  it("keeps only internet descriptors with a non-empty allowlist, hosts normalized", () => {
    const fetchable = fetchableInternetSources([
      internet({ allowedHosts: ["Docs.Example.com.", " ", "docs.example.com"] }),
      internet({ id: "i2", allowedHosts: [] }),
      internet({ id: "i3", allowedHosts: undefined }),
      { id: "g1", name: "Repo", kind: "git", url: "https://example.com/r.git" },
      { id: "a1", name: "Agent", kind: "agent" }
    ]);
    assert.deepEqual(fetchable, [
      { sourceId: "i1", name: "Vendor docs", url: "https://docs.example.com/start", allowedHosts: ["docs.example.com"] }
    ]);
  });
});

describe("UrlFetcher", () => {
  it("fetches an allowlisted https page and returns its text", async () => {
    const calls: string[] = [];
    const fetcher = new UrlFetcher(fetchableInternetSources([internet()]), budget(), {
      fetchImpl: scriptedFetch([{ body: "retention is 12 months" }], calls)
    });
    const text = await fetcher.fetch("https://docs.example.com/retention");
    assert.equal(text, "retention is 12 months");
    assert.deepEqual(calls, ["https://docs.example.com/retention"]);
  });

  it("refuses non-https URLs, unlisted hosts, and unparseable URLs as tool errors", async () => {
    const fetcher = new UrlFetcher(fetchableInternetSources([internet()]), budget(), {
      fetchImpl: scriptedFetch([{}])
    });
    await assert.rejects(fetcher.fetch("http://docs.example.com/x"), SourceToolError);
    await assert.rejects(fetcher.fetch("https://evil.example.com/x"), (error: unknown) => {
      assert.ok(error instanceof SourceToolError);
      assert.match(error.message, /not on the fetch allowlist/);
      return true;
    });
    await assert.rejects(fetcher.fetch("not a url"), SourceToolError);
    // Sub/parent domains of an allowlisted host are NOT allowed — exact match only.
    await assert.rejects(fetcher.fetch("https://sub.docs.example.com/x"), SourceToolError);
    await assert.rejects(fetcher.fetch("https://example.com/x"), SourceToolError);
  });

  it("follows redirects, re-validating every hop against the allowlist", async () => {
    const calls: string[] = [];
    const fetcher = new UrlFetcher(fetchableInternetSources([internet()]), budget(), {
      fetchImpl: scriptedFetch(
        [
          { status: 301, headers: { location: "/moved" } },
          { body: "moved content" }
        ],
        calls
      )
    });
    const text = await fetcher.fetch("https://docs.example.com/old");
    assert.match(text, /\[content served from https:\/\/docs\.example\.com\/moved\]/);
    assert.match(text, /moved content/);
    assert.deepEqual(calls, ["https://docs.example.com/old", "https://docs.example.com/moved"]);
  });

  it("refuses a redirect that leaves the allowlist", async () => {
    const fetcher = new UrlFetcher(fetchableInternetSources([internet()]), budget(), {
      fetchImpl: scriptedFetch([{ status: 302, headers: { location: "https://evil.example.com/steal" } }])
    });
    await assert.rejects(fetcher.fetch("https://docs.example.com/old"), (error: unknown) => {
      assert.ok(error instanceof SourceToolError);
      assert.match(error.message, /not on the fetch allowlist/);
      return true;
    });
  });

  it("gives up after too many redirects", async () => {
    const fetcher = new UrlFetcher(fetchableInternetSources([internet()]), budget(), {
      fetchImpl: scriptedFetch([{ status: 302, headers: { location: "/loop" } }])
    });
    await assert.rejects(fetcher.fetch("https://docs.example.com/loop"), (error: unknown) => {
      assert.ok(error instanceof SourceToolError);
      assert.match(error.message, /redirects/);
      return true;
    });
  });

  it("surfaces HTTP error statuses and non-text content types as tool errors", async () => {
    const failing = new UrlFetcher(fetchableInternetSources([internet()]), budget(), {
      fetchImpl: scriptedFetch([{ status: 404 }])
    });
    await assert.rejects(failing.fetch("https://docs.example.com/missing"), (error: unknown) => {
      assert.ok(error instanceof SourceToolError);
      assert.match(error.message, /HTTP 404/);
      return true;
    });
    const binary = new UrlFetcher(fetchableInternetSources([internet()]), budget(), {
      fetchImpl: scriptedFetch([{ headers: { "content-type": "application/pdf" } }])
    });
    await assert.rejects(binary.fetch("https://docs.example.com/file.pdf"), (error: unknown) => {
      assert.ok(error instanceof SourceToolError);
      assert.match(error.message, /not a text resource \(application\/pdf\)/);
      return true;
    });
  });

  it("turns a network failure into a recoverable tool error", async () => {
    const fetcher = new UrlFetcher(fetchableInternetSources([internet()]), budget(), {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      }
    });
    await assert.rejects(fetcher.fetch("https://docs.example.com/x"), SourceToolError);
  });

  it("reduces HTML to readable text", async () => {
    const html = "<html><head><style>.x{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>Body &amp; more</p></body></html>";
    const fetcher = new UrlFetcher(fetchableInternetSources([internet()]), budget(), {
      fetchImpl: scriptedFetch([{ headers: { "content-type": "text/html; charset=utf-8" }, body: html }])
    });
    const text = await fetcher.fetch("https://docs.example.com/page");
    assert.equal(text, "Title\nBody & more");
  });

  it("slices long pages, charges the shared budget, and serves offsets from cache", async () => {
    const calls: string[] = [];
    const longBody = "a".repeat(40_000);
    const shared = budget();
    const fetcher = new UrlFetcher(fetchableInternetSources([internet()]), shared, {
      fetchImpl: scriptedFetch([{ body: longBody }], calls)
    });
    const first = await fetcher.fetch("https://docs.example.com/long");
    assert.match(first, /\[truncated at 32000 of 40000 chars; re-call with offset=32000 if needed\]/);
    assert.equal(shared.remainingBytes, 400_000 - 32_000);
    const rest = await fetcher.fetch("https://docs.example.com/long", 32_000);
    assert.equal(rest, "a".repeat(8_000));
    assert.deepEqual(calls, ["https://docs.example.com/long"], "second slice came from cache, not the network");
  });

  it("refuses to fetch once the budget is exhausted and rejects bad offsets", async () => {
    const fetcher = new UrlFetcher(fetchableInternetSources([internet()]), budget(0), {
      fetchImpl: scriptedFetch([{ body: "x" }])
    });
    await assert.rejects(fetcher.fetch("https://docs.example.com/x"), (error: unknown) => {
      assert.ok(error instanceof SourceToolError);
      assert.match(error.message, /read budget exhausted/);
      return true;
    });
    const ok = new UrlFetcher(fetchableInternetSources([internet()]), budget(), {
      fetchImpl: scriptedFetch([{ body: "x" }])
    });
    await assert.rejects(ok.fetch("https://docs.example.com/x", -1), SourceToolError);
    await assert.rejects(ok.fetch("https://docs.example.com/x", 1.5), SourceToolError);
  });

  it("rejects a response that exceeds the download cap", async () => {
    // 3MB body against the 2MB cap.
    const fetcher = new UrlFetcher(fetchableInternetSources([internet()]), budget(), {
      fetchImpl: scriptedFetch([{ body: "b".repeat(3 * 1024 * 1024) }])
    });
    await assert.rejects(fetcher.fetch("https://docs.example.com/huge"), (error: unknown) => {
      assert.ok(error instanceof SourceToolError);
      assert.match(error.message, /fetch cap/);
      return true;
    });
  });
});

describe("htmlToText", () => {
  it("drops invisible subtrees, breaks on structure, and decodes entities", () => {
    const text = htmlToText(
      "<div>one</div><noscript>hidden</noscript><ul><li>two&nbsp;&gt;</li></ul><!-- comment --><pre>three&#39;s</pre>"
    );
    assert.equal(text, "one\ntwo >\nthree's");
  });
});
