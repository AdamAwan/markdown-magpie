import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CORRELATION_HEADER, correlation } from "./correlation.js";
import { HttpWatcherApi } from "./http-client.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Captures the headers of the next fetch and returns an empty JSON 200.
function captureHeaders(): () => Headers | undefined {
  let seen: Headers | undefined;
  globalThis.fetch = async (_input, init) => {
    seen = new Headers(init?.headers);
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  return () => seen;
}

test("forwards the in-scope correlation id as a header on callbacks", async () => {
  const headers = captureHeaders();
  const api = new HttpWatcherApi({ apiBaseUrl: "http://api.test", workerName: "w1" });

  await correlation.run("chain-9", () => api.complete("job-1", { ok: true }));

  assert.equal(headers()?.get(CORRELATION_HEADER), "chain-9");
});

test("omits the correlation header when no id is in scope", async () => {
  const headers = captureHeaders();
  const api = new HttpWatcherApi({ apiBaseUrl: "http://api.test", workerName: "w1" });

  await api.complete("job-1", { ok: true });

  assert.equal(headers()?.has(CORRELATION_HEADER), false);
});
