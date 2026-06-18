import { test } from "node:test";
import assert from "node:assert/strict";
import { getJson } from "./kb-client.js";

// Locks the contract Task 4 added: when a token is supplied, getJson attaches a
// single lowercase `authorization: Bearer <token>` header and nothing else.
test("getJson sends the configured bearer token", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Headers[] = [];
  const fetchStub: typeof fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  globalThis.fetch = fetchStub;

  try {
    const body = await getJson("/health", { token: "stdio-token" });

    assert.deepEqual(body, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].get("authorization"), "Bearer stdio-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Confirms the disabled-path stays byte-identical: no token means no auth header.
test("getJson omits the authorization header when no token is configured", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Headers[] = [];
  const fetchStub: typeof fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  globalThis.fetch = fetchStub;

  try {
    await getJson("/health");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].has("authorization"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
