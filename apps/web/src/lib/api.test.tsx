import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { apiDelete, apiGet, apiPost, errorMessage, resolveApiUrl, setAccessTokenProvider } from "./api";

// Captures the arguments the code under test passed to fetch, so each test can
// assert on the real request (method, headers, body, signal) the client built.
interface FetchCall {
  url: string;
  init: RequestInit;
}

const realFetch = globalThis.fetch;

// Install a fake fetch that records the call and returns `response`. A real
// Response is used so the production `readResponse` runs unmodified.
function stubFetch(response: Response | (() => Promise<Response>)): () => FetchCall {
  let call: FetchCall | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    call = { url: String(url), init };
    return typeof response === "function" ? response() : response;
  }) as typeof fetch;
  return () => {
    assert.ok(call, "expected fetch to be called");
    return call;
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  setAccessTokenProvider(undefined);
});

test("resolveApiUrl inserts /api for bare paths but leaves /api paths untouched", () => {
  assert.ok(resolveApiUrl("/health").endsWith("/api/health"));
  assert.ok(resolveApiUrl("/api/health").endsWith("/api/health"));
  assert.ok(resolveApiUrl("/api").endsWith("/api"));
  // A bare path is never double-prefixed.
  assert.equal(resolveApiUrl("/api/health").match(/\/api/g)?.length, 1);
});

test("apiGet returns the parsed JSON body on success", async () => {
  const getCall = stubFetch(new Response(JSON.stringify({ ok: true, value: 7 }), { status: 200 }));

  const result = await apiGet<{ ok: boolean; value: number }>("/health");

  assert.deepEqual(result, { ok: true, value: 7 });
  const { init } = getCall();
  assert.equal(init.method, undefined); // GET is the fetch default
  assert.ok(init.signal instanceof AbortSignal);
});

test("readResponse returns an empty object for an empty body", async () => {
  stubFetch(new Response("", { status: 200 }));
  const result = await apiGet<Record<string, unknown>>("/health");
  assert.deepEqual(result, {});
});

test("readResponse falls back to an empty object when the body is not JSON", async () => {
  // A proxy/crash can return HTML; defensive parsing must not throw on success.
  stubFetch(new Response("<html>not json</html>", { status: 200 }));
  const result = await apiGet<Record<string, unknown>>("/health");
  assert.deepEqual(result, {});
});

test("error responses throw the JSON message field when present", async () => {
  stubFetch(new Response(JSON.stringify({ message: "boom" }), { status: 400 }));
  await assert.rejects(apiGet("/health"), /^Error: boom$/);
});

test("error responses fall back to the raw text when message is not a string", async () => {
  stubFetch(new Response(JSON.stringify({ message: { nested: true } }), { status: 400 }));
  await assert.rejects(apiGet("/health"), (error: Error) => {
    assert.match(error.message, /"message":\{"nested":true\}/);
    return true;
  });
});

test("error responses fall back to statusText when the body is empty", async () => {
  stubFetch(new Response("", { status: 503, statusText: "Service Unavailable" }));
  await assert.rejects(apiGet("/health"), /Service Unavailable/);
});

test("error responses fall back to non-JSON text when there is no message", async () => {
  stubFetch(new Response("upstream exploded", { status: 502 }));
  await assert.rejects(apiGet("/health"), /upstream exploded/);
});

test("apiPost sends JSON with a content-type header and a serialized body", async () => {
  const postCall = stubFetch(new Response(JSON.stringify({ saved: true }), { status: 200 }));

  const result = await apiPost<{ saved: boolean }>("/ask", { question: "hi" });

  assert.deepEqual(result, { saved: true });
  const { init } = postCall();
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>)["content-type"], "application/json");
  assert.equal(init.body, JSON.stringify({ question: "hi" }));
});

test("apiDelete issues a DELETE and returns the parsed body", async () => {
  const deleteCall = stubFetch(new Response(JSON.stringify({ removed: 1 }), { status: 200 }));

  const result = await apiDelete<{ removed: number }>("/questions/1/gap");

  assert.deepEqual(result, { removed: 1 });
  assert.equal(deleteCall().init.method, "DELETE");
});

test("apiPost surfaces error messages from the response", async () => {
  stubFetch(new Response(JSON.stringify({ message: "invalid question" }), { status: 422 }));
  await assert.rejects(apiPost("/ask", {}), /invalid question/);
});

test("an access-token provider adds a bearer Authorization header", async () => {
  const getCall = stubFetch(new Response("{}", { status: 200 }));
  setAccessTokenProvider(async () => "tok-123");

  await apiGet("/health");

  const headers = getCall().init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer tok-123");
});

test("no Authorization header is sent when no provider is registered", async () => {
  const getCall = stubFetch(new Response("{}", { status: 200 }));

  await apiGet("/health");

  const headers = (getCall().init.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, undefined);
});

test("a caller's already-aborted signal is reflected in the combined request signal", async () => {
  const getCall = stubFetch(new Response("{}", { status: 200 }));
  const controller = new AbortController();
  controller.abort();

  await apiGet("/health", { signal: controller.signal });

  assert.equal(getCall().init.signal?.aborted, true);
});

test("the request timeout aborts the underlying fetch", async () => {
  // fetch never resolves on its own; it only settles when the request signal
  // aborts, so this proves the timeout is wired into the fetch signal.
  globalThis.fetch = ((_url: string, init: RequestInit = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
    })) as typeof fetch;

  await assert.rejects(apiGet("/slow", { timeoutMs: 1 }), /aborted by signal/);
});

test("errorMessage unwraps Error instances and labels everything else", () => {
  assert.equal(errorMessage(new Error("specific failure")), "specific failure");
  assert.equal(errorMessage("a string"), "Unexpected console error");
  assert.equal(errorMessage(undefined), "Unexpected console error");
});
