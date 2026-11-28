import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import type { EmbeddingProvider } from "@magpie/core";
import { OpenAICompatibleEmbeddingProvider } from "./embeddings.js";
import { ProviderRequestError } from "./http.js";
import { EmbeddingCircuitBreaker } from "./query-embedding.js";

// A scripted inner provider: each call pops the next outcome.
function scripted(outcomes: Array<Error | number[][]>): EmbeddingProvider & { calls: number } {
  const provider = {
    calls: 0,
    async embed(): Promise<number[][]> {
      provider.calls += 1;
      const next = outcomes.shift();
      if (!next) {
        throw new Error("unscripted call");
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }
  };
  return provider;
}

const down = (): ProviderRequestError =>
  new ProviderRequestError("Embedding provider timed out", { label: "Embedding provider", kind: "timeout" });

describe("EmbeddingCircuitBreaker (J86)", () => {
  it("opens after the failure threshold and then fails fast without calling the provider", async () => {
    let clock = 0;
    const inner = scripted([down(), down(), down()]);
    const events: string[] = [];
    const breaker = new EmbeddingCircuitBreaker(inner, {
      failureThreshold: 3,
      cooldownMs: 30_000,
      now: () => clock,
      onStateChange: (event) => events.push(event.state)
    });
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(breaker.embed(["q"]), /timed out/);
    }
    assert.equal(breaker.state, "open");
    assert.deepEqual(events, ["open"]);
    clock = 10_000;
    await assert.rejects(breaker.embed(["q"]), (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.kind, "circuit_open");
      assert.equal(error.retryAfterMs, 20_000);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(inner.calls, 3, "an open circuit never reaches the provider");
  });

  it("lets one trial through after the cooldown and closes on success", async () => {
    let clock = 0;
    const inner = scripted([down(), [[1]], [[2]]]);
    const events: string[] = [];
    const breaker = new EmbeddingCircuitBreaker(inner, {
      failureThreshold: 1,
      cooldownMs: 1_000,
      now: () => clock,
      onStateChange: (event) => events.push(event.state)
    });
    await assert.rejects(breaker.embed(["q"]));
    clock = 1_000;
    assert.equal(breaker.state, "half-open");
    assert.deepEqual(await breaker.embed(["q"]), [[1]]);
    assert.equal(breaker.state, "closed");
    assert.deepEqual(await breaker.embed(["q"]), [[2]]);
    assert.deepEqual(events, ["open", "closed"]);
  });

  it("re-opens immediately when the half-open trial fails", async () => {
    let clock = 0;
    const inner = scripted([down(), down(), down()]);
    const breaker = new EmbeddingCircuitBreaker(inner, { failureThreshold: 2, cooldownMs: 1_000, now: () => clock });
    await assert.rejects(breaker.embed(["q"]));
    await assert.rejects(breaker.embed(["q"]));
    clock = 1_500;
    await assert.rejects(breaker.embed(["q"]), /timed out/);
    assert.equal(breaker.state, "open", "one failed trial is enough to re-open");
    assert.equal(inner.calls, 3);
  });

  it("does not trip on a request-specific 4xx", async () => {
    const tooLong = new ProviderRequestError("Embedding provider failed with 400", {
      label: "Embedding provider",
      kind: "http_status",
      status: 400
    });
    const inner = scripted([tooLong, tooLong, [[1]]]);
    const breaker = new EmbeddingCircuitBreaker(inner, { failureThreshold: 1 });
    await assert.rejects(breaker.embed(["q"]));
    await assert.rejects(breaker.embed(["q"]));
    assert.equal(breaker.state, "closed");
    assert.deepEqual(await breaker.embed(["q"]), [[1]]);
  });
});

describe("embedding provider typed errors (J82)", () => {
  it("exposes status and Retry-After on a 429 so callers can back off", async () => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(429, { "retry-after": "7", "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const provider = new OpenAICompatibleEmbeddingProvider(
        { baseUrl: `http://127.0.0.1:${address.port}`, model: "m" },
        1_000
      );
      await assert.rejects(provider.embed(["a"]), (error: unknown) => {
        assert.ok(error instanceof ProviderRequestError);
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterMs, 7_000);
        assert.equal(error.retryable, true);
        assert.equal(error.message, "Embedding provider failed with 429: rate limited");
        return true;
      });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
