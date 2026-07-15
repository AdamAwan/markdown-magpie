import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HttpWatcherApi } from "./http-client.js";

// A fake global fetch that resolves/rejects according to a scripted sequence of
// responses, one per call — used to exercise complete()'s retry loop against a
// mix of network errors, 5xx, and a final success (or a terminal 4xx).
type ScriptedResponse = { status: number; body?: unknown } | { networkError: true };

function installScriptedFetch(script: ScriptedResponse[]): { calls: number; bodies: unknown[] } {
  const state = { calls: 0, bodies: [] as unknown[] };
  const queue = [...script];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    state.calls += 1;
    state.bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
    const next = queue.shift();
    if (!next) throw new Error("scripted fetch exhausted");
    if ("networkError" in next) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return state;
}

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

describe("HttpWatcherApi complete() retry", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("retries a completion POST after a transient 5xx and succeeds without falling back", async () => {
    const state = installScriptedFetch([
      { status: 503, body: "service unavailable" },
      { status: 200, body: { job: { id: "job-1" } } }
    ]);
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      completeRetryBaseDelayMs: 1
    });

    await api.complete("job-1", { answer: "ok" });
    assert.equal(state.calls, 2, "expected one retry after the 503");
  });

  it("sends usage and the execution identity flat on the completion body", async () => {
    // provider/model ride the body beside executor/usage — the flat fields the
    // API's completeJobBodySchema expects — so token spend can be priced later.
    const state = installScriptedFetch([{ status: 200, body: { job: { id: "job-1" } } }]);
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      completeRetryBaseDelayMs: 1
    });

    await api.complete("job-1", { answer: "ok" }, { inputTokens: 10, outputTokens: 2 }, { provider: "openai-compatible", model: "gpt-test" });
    assert.deepEqual(state.bodies[0], {
      output: { answer: "ok" },
      executor: "test-worker",
      usage: { inputTokens: 10, outputTokens: 2 },
      provider: "openai-compatible",
      model: "gpt-test"
    });
  });

  it("omits identity fields entirely when the runner reports none", async () => {
    const state = installScriptedFetch([{ status: 200, body: { job: { id: "job-1" } } }]);
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      completeRetryBaseDelayMs: 1
    });

    await api.complete("job-1", { answer: "ok" });
    assert.deepEqual(state.bodies[0], { output: { answer: "ok" }, executor: "test-worker" });
  });

  it("retries a completion POST after a network error and succeeds", async () => {
    const state = installScriptedFetch([{ networkError: true }, { status: 200, body: {} }]);
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      completeRetryBaseDelayMs: 1
    });

    await api.complete("job-1", { answer: "ok" });
    assert.equal(state.calls, 2);
  });

  it("gives up after exhausting retries on a persistent 5xx", async () => {
    const state = installScriptedFetch([
      { status: 502 },
      { status: 502 },
      { status: 502 },
      { status: 502 }
    ]);
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      completeRetryBaseDelayMs: 1
    });

    await assert.rejects(api.complete("job-1", { answer: "ok" }), /502/);
    // One initial attempt + 3 retries = 4 calls total, then it gives up.
    assert.equal(state.calls, 4);
  });

  it("does not retry a deterministic 4xx contract failure (e.g. invalid_output)", async () => {
    const state = installScriptedFetch([{ status: 400, body: { error: "invalid_output" } }]);
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      completeRetryBaseDelayMs: 1
    });

    await assert.rejects(api.complete("job-1", { answer: "ok" }), /400/);
    assert.equal(state.calls, 1, "a 4xx must fail immediately, not retry");
  });
});
