import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HttpWatcherApi } from "./http-client.js";

// docs/ai-jobs.md J53: the shutdown hand-back is POST /api/jobs/:id/release,
// carrying the worker name (so the API marks this watcher idle) and bounded by
// the caller's signal.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("HttpWatcherApi.release", () => {
  it("POSTs the release route with the watcher's name and claimed attempt", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      });
      return new Response(JSON.stringify({ job: { id: "job-1", state: "created" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const api = new HttpWatcherApi({ apiBaseUrl: "http://api.test", workerName: "w1" });
    await api.release({ id: "job-1", retryCount: 2 });
    assert.deepEqual(calls, [
      { url: "http://api.test/api/jobs/job-1/release", method: "POST", body: { workerName: "w1", attempt: 2 } }
    ]);
  });

  it("rejects once the caller's signal fires (a draining watcher never hangs on it)", async () => {
    globalThis.fetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const api = new HttpWatcherApi({ apiBaseUrl: "http://api.test", workerName: "w1" });
    // AbortSignal.timeout's timer is unref'd, so with a fetch that never
    // settles nothing would keep the event loop alive until it fires; a ref'd
    // timer driving an AbortController does.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("release deadline")), 10);
    try {
      await assert.rejects(api.release({ id: "job-1", retryCount: 0 }, controller.signal));
    } finally {
      clearTimeout(timer);
    }
  });
});
