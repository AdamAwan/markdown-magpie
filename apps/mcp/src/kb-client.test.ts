import { test } from "node:test";
import assert from "node:assert/strict";

// The client reads ANSWER_POLL_INTERVAL_MS / ANSWER_TIMEOUT_MS into top-level
// consts at module-evaluation time, so the wait/poll suite must pin tiny values
// *before* it imports kb-client. ES `import` is hoisted, so we set them here (the
// first executed statement) and pull the module in via a lazy dynamic import that
// only resolves once these are in place. The getJson suite below uses the same
// already-loaded instance, which is fine — it never sleeps.
process.env.ANSWER_POLL_INTERVAL_MS = "1";
process.env.ANSWER_TIMEOUT_MS = "50";

const { getJson, askQuestion } = await import("./kb-client.js");

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

// ── askQuestion wait/poll state machine ───────────────────────────────────────
//
// askQuestion is a create→wait→poll loop over the durable answer_question job:
//   POST /ask        → 202 { questionId, job, links: { wait, job } }
//   GET  links.wait  → long-poll; terminal job (200) or current projection (202)
//   GET  links.job   → detail poll, repeated until terminal
// We stub globalThis.fetch with a scripted handler keyed on URL so every branch
// is exercised hermetically — no network, and the only sleeps are the 1ms poll
// interval pinned via ANSWER_POLL_INTERVAL_MS above (timeout pinned to 50ms).

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

// Builds a fetch stub that records every requested URL and dispatches to a
// per-URL handler. Detail-poll handlers receive the (1-based) call count for
// that URL so a test can return non-terminal-then-terminal across polls.
interface StubHandlers {
  ask: () => Response;
  wait?: () => Response;
  job?: (callIndex: number) => Response;
}

function stubFetch(handlers: StubHandlers): { urls: string[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const jobCalls = new Map<string, number>();

  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);

    if (url.endsWith("/api/ask")) {
      return handlers.ask();
    }
    if (url.includes("/wait")) {
      if (!handlers.wait) {
        throw new Error(`unexpected wait request: ${url}`);
      }
      return handlers.wait();
    }
    // Detail poll: GET /api/jobs/:id
    if (!handlers.job) {
      throw new Error(`unexpected detail-poll request: ${url}`);
    }
    const next = (jobCalls.get(url) ?? 0) + 1;
    jobCalls.set(url, next);
    return handlers.job(next);
  };

  globalThis.fetch = fetchStub;
  return { urls, restore: () => (globalThis.fetch = originalFetch) };
}

const askBody = {
  questionId: "q-123",
  job: { id: "job-1", state: "created" },
  links: { wait: "/api/jobs/job-1/wait", job: "/api/jobs/job-1" }
};

const completedOutput = {
  result: {
    answer: "Magpies collect shiny markdown.",
    confidence: "high",
    citations: [{ title: "doc-a" }],
    gaps: ["nothing on corvids"]
  },
  executor: "watcher"
};

// 1. Happy path: the wait link returns a completed job; askQuestion returns the
// fields from output.result (NOT output itself) plus the questionId.
test("askQuestion returns the answer from a completed wait response", async () => {
  const stub = stubFetch({
    ask: () => jsonResponse(askBody, 202),
    wait: () => jsonResponse({ job: { id: "job-1", state: "completed", output: completedOutput } })
  });

  try {
    const result = await askQuestion("where do magpies nest?");

    assert.deepEqual(result, {
      answer: "Magpies collect shiny markdown.",
      confidence: "high",
      citations: [{ title: "doc-a" }],
      gaps: ["nothing on corvids"],
      questionId: "q-123"
    });
    // ask + single wait, no detail poll needed.
    assert.equal(stub.urls.length, 2);
    assert.ok(stub.urls[1].endsWith("/api/jobs/job-1/wait"));
  } finally {
    stub.restore();
  }
});

// 2. 202 wait then poll: the wait link returns a non-terminal projection, so the
// client falls back to detail polling until the job completes.
test("askQuestion polls the detail link when the wait response is non-terminal", async () => {
  const stub = stubFetch({
    ask: () => jsonResponse(askBody, 202),
    wait: () => jsonResponse({ job: { id: "job-1", state: "active" } }, 202),
    job: (call) =>
      call < 2
        ? jsonResponse({ job: { id: "job-1", state: "active" } }, 202)
        : jsonResponse({ job: { id: "job-1", state: "completed", output: completedOutput } })
  });

  try {
    const result = await askQuestion("where do magpies nest?");

    assert.equal(result.answer, "Magpies collect shiny markdown.");
    assert.equal(result.questionId, "q-123");
    // ask + wait + at least two detail polls (active, then completed).
    const detailPolls = stub.urls.filter((u) => u.endsWith("/api/jobs/job-1"));
    assert.ok(detailPolls.length >= 2, `expected >=2 detail polls, got ${detailPolls.length}`);
  } finally {
    stub.restore();
  }
});

// 3a. failed terminal state: throws naming the job id + state, with no payload.
test("askQuestion throws when the job fails without leaking payload", async () => {
  const stub = stubFetch({
    ask: () => jsonResponse(askBody, 202),
    wait: () =>
      jsonResponse({
        job: { id: "job-1", state: "failed", output: { secret: "do not surface" } }
      })
  });

  try {
    await assert.rejects(
      askQuestion("q"),
      (error: Error) => {
        assert.match(error.message, /job-1/);
        assert.match(error.message, /failed/);
        assert.doesNotMatch(error.message, /secret|do not surface/);
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

// 3b. cancelled terminal state: same contract as failed.
test("askQuestion throws when the job is cancelled without leaking payload", async () => {
  const stub = stubFetch({
    ask: () => jsonResponse(askBody, 202),
    wait: () =>
      jsonResponse({
        job: { id: "job-1", state: "cancelled", output: { secret: "do not surface" } }
      })
  });

  try {
    await assert.rejects(
      askQuestion("q"),
      (error: Error) => {
        assert.match(error.message, /job-1/);
        assert.match(error.message, /cancelled/);
        assert.doesNotMatch(error.message, /secret|do not surface/);
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

// 4. Deadline/timeout: the job never reaches a terminal state within the pinned
// 50ms timeout, so askQuestion throws a timeout error naming the id + last state.
test("askQuestion times out when the job never reaches a terminal state", async () => {
  const stub = stubFetch({
    ask: () => jsonResponse(askBody, 202),
    wait: () => jsonResponse({ job: { id: "job-1", state: "active" } }, 202),
    job: () => jsonResponse({ job: { id: "job-1", state: "retry" } }, 202)
  });

  try {
    await assert.rejects(
      askQuestion("q"),
      (error: Error) => {
        assert.match(error.message, /Timed out/);
        assert.match(error.message, /job-1/);
        assert.match(error.message, /retry/);
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

// 5. Missing links: an ask response without usable wait/job links is rejected up
// front with the dedicated links error (the wait handler is never reached).
test("askQuestion throws when the ask response omits job links", async () => {
  const stub = stubFetch({
    // `links` present but with no wait/job entries → the dedicated links error.
    ask: () => jsonResponse({ questionId: "q-123", job: { id: "job-1", state: "created" }, links: {} }, 202)
  });

  try {
    await assert.rejects(askQuestion("q"), /did not include job wait\/detail links/);
    // Only the ask call happened — no wait/poll attempted.
    assert.equal(stub.urls.length, 1);
  } finally {
    stub.restore();
  }
});
