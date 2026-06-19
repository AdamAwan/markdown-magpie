import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiTokenProvider } from "./api-token.js";

const fullConfig = {
  clientId: "mcp-client",
  clientSecret: "mcp-secret",
  tokenUrl: "https://wastedcake.eu.auth0.com/oauth/token",
  audience: "https://magpie.wastedcake.com"
};

function stubFetch(handler: (init: RequestInit | undefined) => Response): { restore: () => void; calls: () => number } {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    count += 1;
    return handler(init);
  };
  return { restore: () => (globalThis.fetch = original), calls: () => count };
}

function tokenResponse(accessToken: string, expiresIn: number): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("falls back to the static token when no client-credentials config is given", async () => {
  const provider = createApiTokenProvider({ staticToken: "static-token" });
  assert.equal(await provider(), "static-token");
});

test("returns undefined when neither static token nor client-credentials are configured", async () => {
  const provider = createApiTokenProvider({});
  assert.equal(await provider(), undefined);
});

test("fetches a token via client-credentials and sends the expected grant body", async () => {
  let capturedBody: unknown;
  const fetchStub = stubFetch((init) => {
    capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
    return tokenResponse("fetched-token", 3600);
  });
  try {
    const provider = createApiTokenProvider(fullConfig);
    assert.equal(await provider(), "fetched-token");
    assert.deepEqual(capturedBody, {
      grant_type: "client_credentials",
      client_id: "mcp-client",
      client_secret: "mcp-secret",
      audience: "https://magpie.wastedcake.com"
    });
  } finally {
    fetchStub.restore();
  }
});

test("caches the token within its lifetime (no second network call)", async () => {
  const fetchStub = stubFetch(() => tokenResponse("cached-token", 3600));
  try {
    const provider = createApiTokenProvider(fullConfig);
    assert.equal(await provider(), "cached-token");
    assert.equal(await provider(), "cached-token");
    assert.equal(fetchStub.calls(), 1, "expected the token to be cached, not re-fetched");
  } finally {
    fetchStub.restore();
  }
});

test("refreshes the token once it is within the expiry skew window", async () => {
  let n = 0;
  // expires_in below the 60s skew forces the cache to be treated as expired
  // immediately, so each call refreshes.
  const fetchStub = stubFetch(() => tokenResponse(`token-${++n}`, 30));
  try {
    const provider = createApiTokenProvider(fullConfig);
    assert.equal(await provider(), "token-1");
    assert.equal(await provider(), "token-2");
    assert.equal(fetchStub.calls(), 2, "expected a refresh on the second call");
  } finally {
    fetchStub.restore();
  }
});

test("throws a clear error when the token endpoint fails", async () => {
  const fetchStub = stubFetch(() => new Response("nope", { status: 401 }));
  try {
    const provider = createApiTokenProvider(fullConfig);
    await assert.rejects(() => provider(), /Failed to obtain MCP API service token \(401\)/);
  } finally {
    fetchStub.restore();
  }
});

test("throws when the token endpoint omits access_token", async () => {
  const fetchStub = stubFetch(
    () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } })
  );
  try {
    const provider = createApiTokenProvider(fullConfig);
    await assert.rejects(() => provider(), /did not include an access_token/);
  } finally {
    fetchStub.restore();
  }
});
