import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HttpWatcherApi } from "./http-client.js";

// A fake global fetch that resolves with `body` after `delayMs`, but rejects
// with the request's abort reason if its signal fires first — exactly how undici
// surfaces an AbortSignal.timeout (a DOMException named "TimeoutError"). This lets
// the tests exercise the client's real timeout/abort plumbing deterministically
// with tiny durations.
function installFakeFetch(delayMs: number, body: unknown): void {
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      const timer = setTimeout(() => {
        resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }, delayMs);
      if (signal) {
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    })) as typeof fetch;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("HttpWatcherApi request timeouts", () => {
  it("aborts a hot-path call (claim) at the short default request timeout", async () => {
    installFakeFetch(100, { job: null });
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      requestTimeoutMs: 20,
      maintenanceTimeoutMs: 500
    });

    await assert.rejects(api.claim("test-worker", []), /timed out after 20ms/);
  });

  it("lets a maintenance orchestration call (runFixPatrol) run past the short default timeout", async () => {
    installFakeFetch(100, { runId: "run-1", selectedCount: 3, findingCount: 1 });
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      requestTimeoutMs: 20,
      maintenanceTimeoutMs: 500
    });

    const result = await api.runFixPatrol(undefined);
    assert.deepEqual(result, { runId: "run-1", selectedCount: 3, findingCount: 1 });
  });
});
