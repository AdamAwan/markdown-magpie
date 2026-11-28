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

// A claimed job: the id plus the attempt (retryCount) it was claimed at.
const JOB = { id: "job-1", retryCount: 2 };
// A retry schedule fast enough for tests that only care whether a retry happens.
const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 2, budgetMs: 1_000 };
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
      settleRetry: FAST_RETRY
    });

    await api.complete(JOB, { answer: "ok" });
    assert.equal(state.calls, 2, "expected one retry after the 503");
  });

  it("sends usage and the execution identity flat on the completion body", async () => {
    // provider/model ride the body beside executor/usage — the flat fields the
    // API's completeJobBodySchema expects — so token spend can be priced later.
    const state = installScriptedFetch([{ status: 200, body: { job: { id: "job-1" } } }]);
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      settleRetry: FAST_RETRY
    });

    await api.complete(
      JOB,
      { answer: "ok" },
      { inputTokens: 10, outputTokens: 2 },
      { provider: "openai-compatible", model: "gpt-test" }
    );
    assert.deepEqual(state.bodies[0], {
      output: { answer: "ok" },
      executor: "test-worker",
      attempt: 2,
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
      settleRetry: FAST_RETRY
    });

    await api.complete(JOB, { answer: "ok" });
    assert.deepEqual(state.bodies[0], { output: { answer: "ok" }, executor: "test-worker", attempt: 2 });
  });

  it("retries a completion POST after a network error and succeeds", async () => {
    const state = installScriptedFetch([{ networkError: true }, { status: 200, body: {} }]);
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      settleRetry: FAST_RETRY
    });

    await api.complete(JOB, { answer: "ok" });
    assert.equal(state.calls, 2);
  });

  it("keeps retrying a persistent 5xx until the time budget is spent, then gives up (J61)", async () => {
    const state = installScriptedFetch(Array.from({ length: 200 }, () => ({ status: 502 })));
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      // Delays 2,4,8,8,8… ms (capped, jittered over the upper half): a 60ms
      // budget allows several retries, never an unbounded loop.
      settleRetry: { baseDelayMs: 4, maxDelayMs: 16, budgetMs: 60 }
    });

    const startedAt = Date.now();
    await assert.rejects(api.complete(JOB, { answer: "ok" }), /502/);
    assert.ok(state.calls >= 4, `expected several retries within the budget, got ${state.calls}`);
    assert.ok(state.calls < 60, `expected the budget to bound the retries, got ${state.calls}`);
    assert.ok(Date.now() - startedAt < 1_000, "gave up near the budget");
  });

  it("retries 429 and 408 as transient, like a 5xx", async () => {
    const state = installScriptedFetch([{ status: 429 }, { status: 408 }, { status: 200, body: {} }]);
    const api = new HttpWatcherApi({ apiBaseUrl: "http://api.test", workerName: "w", settleRetry: FAST_RETRY });
    await api.complete(JOB, { answer: "ok" });
    assert.equal(state.calls, 3);
  });

  it("does not retry a 409 (cancelled, or no longer held by this attempt — J62)", async () => {
    const state = installScriptedFetch([{ status: 409, body: { error: "job_not_active" } }]);
    const api = new HttpWatcherApi({ apiBaseUrl: "http://api.test", workerName: "w", settleRetry: FAST_RETRY });
    await assert.rejects(api.complete(JOB, { answer: "ok" }), /409/);
    assert.equal(state.calls, 1);
  });

  it("does not retry a deterministic 4xx contract failure (e.g. invalid_output)", async () => {
    const state = installScriptedFetch([{ status: 400, body: { error: "invalid_output" } }]);
    const api = new HttpWatcherApi({
      apiBaseUrl: "http://api.test",
      workerName: "test-worker",
      settleRetry: FAST_RETRY
    });

    await assert.rejects(api.complete(JOB, { answer: "ok" }), /400/);
    assert.equal(state.calls, 1, "a 4xx must fail immediately, not retry");
  });
});

describe("HttpWatcherApi fail() retry (API31)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("retries a failure POST after a 5xx or a network error and sends the attempt", async () => {
    const state = installScriptedFetch([{ status: 500 }, { networkError: true }, { status: 200, body: {} }]);
    const api = new HttpWatcherApi({ apiBaseUrl: "http://api.test", workerName: "w", settleRetry: FAST_RETRY });
    await api.fail(JOB, { code: "runner_failed", message: "boom", category: "internal" });
    assert.equal(state.calls, 3);
    assert.deepEqual(state.bodies[2], {
      error: { code: "runner_failed", message: "boom", category: "internal", executor: "w" },
      attempt: 2
    });
  });

  it("does not retry a 404 (the job is gone)", async () => {
    const state = installScriptedFetch([{ status: 404, body: { error: "job_not_found" } }]);
    const api = new HttpWatcherApi({ apiBaseUrl: "http://api.test", workerName: "w", settleRetry: FAST_RETRY });
    await assert.rejects(api.fail(JOB, { code: "x", message: "y", category: "internal" }), /404/);
    assert.equal(state.calls, 1);
  });
});

describe("HttpWatcherApi heartbeat() (J60)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sends the claimed attempt and reports whether this attempt still holds the job", async () => {
    const state = installScriptedFetch([
      { status: 200, body: { cancelled: false, active: true } },
      { status: 200, body: { cancelled: false, active: false } },
      // An API predating J60 sends no `active`: read as still held.
      { status: 200, body: { cancelled: false } }
    ]);
    const api = new HttpWatcherApi({ apiBaseUrl: "http://api.test", workerName: "w" });
    assert.deepEqual(await api.heartbeat(JOB), { cancelled: false, active: true });
    assert.deepEqual(await api.heartbeat(JOB), { cancelled: false, active: false });
    assert.deepEqual(await api.heartbeat(JOB), { cancelled: false, active: true });
    assert.deepEqual(state.bodies[0], { workerName: "w", attempt: 2 });
  });
});
