import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";
import { OpenAICompatibleChatProvider } from "./chat-providers.js";
import {
  describeErrorBody,
  fetchWithTimeout,
  parseRetryAfterMs,
  ProviderOutputTruncatedError,
  ProviderRequestError,
  withProviderRetry
} from "./http.js";

// A real local HTTP server scripted per test: each request pops the next
// handler, so a test reads as the provider's sequence of replies.
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let queue: Handler[] = [];
let requests = 0;
let baseUrl = "";
const server = createServer((req, res) => {
  requests += 1;
  req.resume();
  const handler = queue.shift();
  if (!handler) {
    res.writeHead(500).end("unscripted request");
    return;
  }
  handler(req, res);
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

function script(...handlers: Handler[]): void {
  queue = handlers;
  requests = 0;
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  };
const ok = (content: string, finishReason = "stop"): Handler =>
  json(200, { choices: [{ message: { content }, finish_reason: finishReason }], usage: { completion_tokens: 7 } });

function provider(waits: number[] = []): OpenAICompatibleChatProvider {
  return new OpenAICompatibleChatProvider({ apiKey: "sk-test-key-123456", baseUrl, model: "m" }, 5_000, {
    retryHooks: {
      // Record the wait instead of sleeping, so the test is fast and exact.
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 0
    }
  });
}

const request = { system: "s", messages: [{ role: "user" as const, content: "q" }] };

describe("chat provider retry (J81)", () => {
  it("retries a 429 after the provider's Retry-After, then succeeds", async () => {
    const waits: number[] = [];
    script(json(429, { error: { message: "slow down" } }, { "retry-after": "2" }), ok("hello"));
    const response = await provider(waits).complete(request);
    assert.equal(response.content, "hello");
    assert.equal(requests, 2);
    assert.deepEqual(waits, [2000], "waited exactly the Retry-After");
  });

  it("retries 5xx with exponential backoff and gives up after the bounded attempts", async () => {
    const waits: number[] = [];
    script(json(503, {}), json(502, {}), json(500, { error: { message: "boom" } }));
    await assert.rejects(provider(waits).complete(request), (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.status, 500);
      assert.equal(error.retryable, true);
      return true;
    });
    assert.equal(requests, 3, "original + 2 retries");
    assert.deepEqual(waits, [500, 1000], "equal-jitter backoff with random()=0");
  });

  it("does not retry a non-transient 4xx", async () => {
    script(json(400, { error: { message: "bad request" } }));
    await assert.rejects(provider().complete(request), (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(requests, 1);
  });

  it("does not wait out a Retry-After longer than the policy's max delay", async () => {
    const waits: number[] = [];
    script(json(429, {}, { "retry-after": "3600" }));
    await assert.rejects(provider(waits).complete(request), (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.retryAfterMs, 3_600_000, "the hint is surfaced for the job-level retry");
      return true;
    });
    assert.deepEqual(waits, []);
  });

  it("stops retrying when the caller aborts during the wait", async () => {
    const controller = new AbortController();
    script(json(503, {}), ok("never"));
    const chat = new OpenAICompatibleChatProvider({ apiKey: "k", baseUrl, model: "m" }, 5_000, {
      retry: { baseDelayMs: 60_000, maxDelayMs: 60_000 }
    });
    const pending = chat.complete({ ...request, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("job cancelled")), 50);
    await assert.rejects(pending, /job cancelled/);
    assert.equal(requests, 1, "no second attempt after the abort");
  });
});

describe("chat provider errors and truncation (J82, J83)", () => {
  it("keeps only a short redacted summary of the error body", async () => {
    const echoed = `invalid key sk-live-abcdefghijklmnop for prompt: ${"SECRET PROMPT TEXT ".repeat(100)}`;
    script(json(401, { error: { message: echoed } }));
    await assert.rejects(provider().complete(request), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /sk-live-abcdefghijklmnop/);
      assert.ok(error.message.length < 400, `message is bounded (${error.message.length} chars)`);
      return true;
    });
  });

  it("fails finish_reason length as a distinct truncation, never as content", async () => {
    script(ok('{"answer": "half an ans', "length"));
    await assert.rejects(provider().complete(request), (error: unknown) => {
      assert.ok(error instanceof ProviderOutputTruncatedError);
      assert.match(error.message, /after 7 output tokens/);
      return true;
    });
    assert.equal(requests, 1, "truncation is deterministic — not retried in-process");
  });
});

describe("http helpers", () => {
  it("parses Retry-After seconds, HTTP-dates and retry-after-ms", () => {
    assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "5" })), 5000);
    assert.equal(parseRetryAfterMs(new Headers({ "retry-after-ms": "250", "retry-after": "5" })), 250);
    const now = Date.parse("2026-01-01T00:00:00Z");
    assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:10 GMT" }), now), 10_000);
    assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "soon" })), undefined);
    assert.equal(parseRetryAfterMs(new Headers()), undefined);
  });

  it("describes error bodies without credentials", () => {
    assert.equal(describeErrorBody('{"error":{"message":"quota exceeded"}}'), "quota exceeded");
    assert.equal(describeErrorBody("token=abc123 Bearer xyz.987"), "token=[redacted] Bearer [redacted]");
    assert.equal(describeErrorBody("x".repeat(1000)).length, 301);
  });

  it("types a timeout and a refused connection as retryable request failures", async () => {
    script((_req, res) => setTimeout(() => res.end("late"), 500));
    await assert.rejects(fetchWithTimeout(`${baseUrl}/slow`, {}, 50, "Probe"), (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.kind, "timeout");
      assert.equal(error.retryable, true);
      return true;
    });
    await assert.rejects(fetchWithTimeout("http://127.0.0.1:1/", {}, 1000, "Probe"), (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.kind, "network");
      return true;
    });
  });

  it("propagates the caller's own abort untouched", async () => {
    const controller = new AbortController();
    controller.abort(new Error("mine"));
    await assert.rejects(fetchWithTimeout(`${baseUrl}/x`, {}, 1000, "Probe", controller.signal), /mine/);
  });

  it("does not retry errors that are not provider request failures", async () => {
    let calls = 0;
    await assert.rejects(
      withProviderRetry(
        async () => {
          calls += 1;
          throw new Error("parse failure");
        },
        { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 }
      ),
      /parse failure/
    );
    assert.equal(calls, 1);
  });
});
