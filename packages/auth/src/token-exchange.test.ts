import { test } from "node:test";
import assert from "node:assert/strict";
import { createTokenExchanger } from "./token-exchange.js";

const config = {
  clientId: "mcp-client",
  clientSecret: "mcp-secret",
  tokenUrl: "https://wastedcake.eu.auth0.com/oauth/token",
  audience: "https://magpie.wastedcake.com"
};

function stubFetch(handler: (init: RequestInit | undefined) => Response): {
  restore: () => void;
  calls: () => number;
} {
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

test("exchanges a subject token using the RFC 8693 grant and expected params", async () => {
  let body: URLSearchParams | undefined;
  const fetchStub = stubFetch((init) => {
    body = new URLSearchParams(init?.body as string);
    return tokenResponse("api-token-for-user", 3600);
  });
  try {
    const exchange = createTokenExchanger(config);
    assert.equal(await exchange("user-subject-token"), "api-token-for-user");
    assert.equal(body?.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
    assert.equal(body?.get("subject_token"), "user-subject-token");
    assert.equal(body?.get("subject_token_type"), "urn:ietf:params:oauth:token-type:access_token");
    assert.equal(body?.get("audience"), "https://magpie.wastedcake.com");
    assert.equal(body?.get("client_id"), "mcp-client");
  } finally {
    fetchStub.restore();
  }
});

test("caches per subject token within its lifetime", async () => {
  const fetchStub = stubFetch(() => tokenResponse("cached", 3600));
  try {
    const exchange = createTokenExchanger(config);
    assert.equal(await exchange("subject-a"), "cached");
    assert.equal(await exchange("subject-a"), "cached");
    assert.equal(fetchStub.calls(), 1, "same subject token should reuse the cached exchange");
  } finally {
    fetchStub.restore();
  }
});

test("keeps different users' exchanged tokens separate", async () => {
  const fetchStub = stubFetch((init) => {
    const subject = new URLSearchParams(init?.body as string).get("subject_token");
    return tokenResponse(`token-for-${subject}`, 3600);
  });
  try {
    const exchange = createTokenExchanger(config);
    assert.equal(await exchange("subject-a"), "token-for-subject-a");
    assert.equal(await exchange("subject-b"), "token-for-subject-b");
    assert.equal(fetchStub.calls(), 2);
  } finally {
    fetchStub.restore();
  }
});

test("refreshes once the exchanged token is within the expiry skew window", async () => {
  let n = 0;
  const fetchStub = stubFetch(() => tokenResponse(`token-${++n}`, 30));
  try {
    const exchange = createTokenExchanger(config);
    assert.equal(await exchange("subject-a"), "token-1");
    assert.equal(await exchange("subject-a"), "token-2");
    assert.equal(fetchStub.calls(), 2);
  } finally {
    fetchStub.restore();
  }
});

test("collapses concurrent exchanges of the same subject token into one call", async () => {
  const fetchStub = stubFetch(() => tokenResponse("once", 3600));
  try {
    const exchange = createTokenExchanger(config);
    const [a, b] = await Promise.all([exchange("subject-a"), exchange("subject-a")]);
    assert.equal(a, "once");
    assert.equal(b, "once");
    assert.equal(fetchStub.calls(), 1, "concurrent exchanges should dedupe to one round-trip");
  } finally {
    fetchStub.restore();
  }
});

test("throws a clear error when the exchange endpoint fails", async () => {
  const fetchStub = stubFetch(() => new Response("bad", { status: 403 }));
  try {
    const exchange = createTokenExchanger(config);
    await assert.rejects(() => exchange("subject-a"), /Token exchange failed \(403\)/);
  } finally {
    fetchStub.restore();
  }
});

test("throws when the exchange response omits access_token", async () => {
  const fetchStub = stubFetch(
    () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } })
  );
  try {
    const exchange = createTokenExchanger(config);
    await assert.rejects(() => exchange("subject-a"), /did not include an access_token/);
  } finally {
    fetchStub.restore();
  }
});
