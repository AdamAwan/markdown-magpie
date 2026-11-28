import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import { createLogger } from "@magpie/logger";
import { createHealthServer, loadHealthConfig, TickTracker, type HealthServerConfig } from "./health-server.js";
import type { WorkerLoopApiClient } from "./http-client.js";
import type { JobRunner } from "./runners/types.js";
import { WorkerLoop } from "./worker-loop.js";

function testConfig(overrides: Partial<HealthServerConfig> = {}): HealthServerConfig {
  // Bind every interface ("0.0.0.0") rather than the literal loopback address:
  // binding a host string routes through dns.lookup(), which hangs forever in a
  // sandbox whose loopback getaddrinfo stalls. All-interfaces binds skip the
  // lookup, and the loopback client below is still reachable on the bound port.
  return { port: 0, host: "0.0.0.0", staleAfterMs: 1000, ...overrides };
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe("loadHealthConfig", () => {
  it("applies defaults when nothing is set", () => {
    const config = loadHealthConfig({});
    assert.equal(config.port, 4002);
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.staleAfterMs, 120_000);
  });

  it("parses valid overrides", () => {
    const config = loadHealthConfig({
      WATCHER_HEALTH_PORT: "9999",
      WATCHER_HEALTH_HOST: "127.0.0.1",
      WATCHER_HEALTH_STALE_AFTER_MS: "5000"
    });
    assert.deepEqual(config, { port: 9999, host: "127.0.0.1", staleAfterMs: 5000 });
  });

  it("fails fast on an invalid port", () => {
    assert.throws(() => loadHealthConfig({ WATCHER_HEALTH_PORT: "not-a-number" }), /WATCHER_HEALTH_PORT/);
    assert.throws(() => loadHealthConfig({ WATCHER_HEALTH_PORT: "0" }), /WATCHER_HEALTH_PORT/);
    assert.throws(() => loadHealthConfig({ WATCHER_HEALTH_PORT: "70000" }), /WATCHER_HEALTH_PORT/);
    assert.throws(() => loadHealthConfig({ WATCHER_HEALTH_PORT: "3.5" }), /WATCHER_HEALTH_PORT/);
  });

  it("fails fast on an invalid staleness threshold", () => {
    assert.throws(() => loadHealthConfig({ WATCHER_HEALTH_STALE_AFTER_MS: "0" }), /WATCHER_HEALTH_STALE_AFTER_MS/);
    assert.throws(() => loadHealthConfig({ WATCHER_HEALTH_STALE_AFTER_MS: "-5" }), /WATCHER_HEALTH_STALE_AFTER_MS/);
    assert.throws(() => loadHealthConfig({ WATCHER_HEALTH_STALE_AFTER_MS: "nope" }), /WATCHER_HEALTH_STALE_AFTER_MS/);
  });
});

describe("TickTracker", () => {
  it("reports near-zero staleness immediately after construction", () => {
    const tracker = new TickTracker();
    assert.ok(tracker.msSinceLastTick() < 1000);
  });

  it("resets staleness to (near) zero on tick", () => {
    const tracker = new TickTracker();
    const past = Date.now() - 10_000;
    // Without an intervening tick, staleness grows from the original timestamp.
    assert.ok(tracker.msSinceLastTick(Date.now()) < 10_000);
    assert.ok(tracker.msSinceLastTick(Date.now() + 10_000) >= 10_000);
    tracker.tick();
    // A tick resets the baseline forward, so a past "now" looks negative/zero,
    // not stale.
    assert.ok(tracker.msSinceLastTick(past) < 0);
  });
});

describe("health server", () => {
  it("GET /health returns 200 when ticked recently", async () => {
    const tracker = new TickTracker();
    const health = createHealthServer({ config: testConfig(), tracker, isReady: () => true });
    await health.start();
    try {
      const address = health.server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const { status, body } = await getJson(baseUrl, "/health");
      assert.equal(status, 200);
      assert.equal(body.status, "ok");
    } finally {
      await health.stop();
    }
  });

  it("GET /health returns 503 when the last tick is stale", async () => {
    const tracker = new TickTracker();
    const health = createHealthServer({ config: testConfig({ staleAfterMs: 50 }), tracker, isReady: () => true });
    await health.start();
    try {
      const address = health.server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      await new Promise((resolve) => setTimeout(resolve, 80));

      const { status, body } = await getJson(baseUrl, "/health");
      assert.equal(status, 503);
      assert.equal(body.status, "stale");
    } finally {
      await health.stop();
    }
  });

  it("GET /health stays 200 through a job longer than the staleness threshold (J55)", async () => {
    // The job runs 150ms against a 50ms threshold; only its 10ms heartbeat (a
    // 0.02s heartbeat window, halved) keeps the watcher live while it runs.
    const tracker = new TickTracker();
    const health = createHealthServer({ config: testConfig({ staleAfterMs: 50 }), tracker, isReady: () => true });
    const job: JobView = {
      id: "job-1",
      type: "answer_question",
      queueName: "answer_question__openai_compatible",
      deadLetter: false,
      state: "active",
      input: {},
      retryCount: 0,
      retryLimit: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      expireInSeconds: 300,
      heartbeatSeconds: 0.02
    };
    const api: WorkerLoopApiClient = {
      claim: async () => job,
      heartbeat: async () => ({ cancelled: false }),
      complete: async () => {},
      fail: async () => {},
      release: async () => {}
    };
    const runner: JobRunner = {
      capability: "openai-compatible",
      supports: (type) => type === "answer_question",
      run: () => new Promise((resolve) => setTimeout(() => resolve({}), 150))
    };
    const loop = new WorkerLoop(api, [runner], ["openai-compatible"], "w1", createLogger({ level: "silent" }), {
      pollIntervalMs: 1,
      onTick: () => tracker.tick()
    });
    await health.start();
    try {
      const address = health.server.address();
      assert.ok(address && typeof address === "object");
      const running = loop.tick();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const { status } = await getJson(`http://127.0.0.1:${address.port}`, "/health");
      assert.equal(status, 200, "a long job must not read as a dead watcher");
      await running;
    } finally {
      await health.stop();
    }
  });

  it("GET /ready reflects the isReady callback", async () => {
    const tracker = new TickTracker();
    let ready = false;
    const health = createHealthServer({ config: testConfig(), tracker, isReady: () => ready });
    await health.start();
    try {
      const address = health.server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const notReady = await getJson(baseUrl, "/ready");
      assert.equal(notReady.status, 503);
      assert.equal(notReady.body.status, "not_ready");

      ready = true;
      const isReadyNow = await getJson(baseUrl, "/ready");
      assert.equal(isReadyNow.status, 200);
      assert.equal(isReadyNow.body.status, "ok");
    } finally {
      await health.stop();
    }
  });

  it("returns 404 for unknown paths", async () => {
    const tracker = new TickTracker();
    const health = createHealthServer({ config: testConfig(), tracker, isReady: () => true });
    await health.start();
    try {
      const address = health.server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const { status } = await getJson(baseUrl, "/nope");
      assert.equal(status, 404);
    } finally {
      await health.stop();
    }
  });
});
