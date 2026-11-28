import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Agent, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createLogger } from "@magpie/logger";
import { createDrainableServer, installGracefulShutdown, type DrainableServer } from "./shutdown.js";

// docs/api.md API37/API38: SIGTERM drains in-flight HTTP handlers (bounded) before
// the broker stops and the pool ends; a second signal forces exit.

const silent = createLogger({ level: "silent" });

// A drainable server whose /slow handler answers after `delayMs`; `started`
// resolves when a /slow request arrives so a test can signal mid-request.
function slowServer(
  delayMs: number,
  onAnswered: () => void = () => {}
): { drainable: DrainableServer; started: Promise<void> } {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const drainable = createDrainableServer((req, res) => {
    if (req.url === "/slow") {
      markStarted();
      setTimeout(() => res.end("done", onAnswered), delayMs);
      return;
    }
    res.end("fast");
  });
  return { drainable, started };
}

// Binds every interface (no host string → no dns.lookup, which can stall in a
// sandbox) and returns the ephemeral port.
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return (address satisfies AddressInfo).port;
}

interface Reply {
  status: number;
  body: string;
  connection?: string;
}

function get(port: number, path: string, agent?: Agent): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, connection: res.headers.connection }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("createDrainableServer().drain", () => {
  it("lets an in-flight request on a keep-alive connection finish, then closes promptly", async () => {
    const { drainable, started } = slowServer(80);
    const port = await listen(drainable.server);
    const agent = new Agent({ keepAlive: true });
    try {
      // Warm a keep-alive socket so the drain has an idle connection to close too.
      assert.equal((await get(port, "/fast", agent)).connection, "keep-alive");
      const inFlight = get(port, "/slow", agent);
      await started;
      const startedAt = Date.now();
      const outcome = await drainable.drain(2_000);
      assert.equal(outcome, "drained");
      // The response arrives intact and tells the client not to reuse the socket.
      assert.deepEqual(await inFlight, { status: 200, body: "done", connection: "close" });
      // Closed right after the response — not after a keep-alive timeout or the window.
      assert.ok(Date.now() - startedAt < 1_000, `drain took ${Date.now() - startedAt}ms`);
      assert.equal(drainable.server.listening, false);
    } finally {
      agent.destroy();
    }
  });

  it("force-closes a handler that outlives the drain window", async () => {
    const { drainable, started } = slowServer(1_000);
    const port = await listen(drainable.server);
    const inFlight = get(port, "/slow").catch((error: unknown) => error);
    await started;
    assert.equal(await drainable.drain(50), "forced");
    assert.ok((await inFlight) instanceof Error, "the cut-off request sees its connection reset");
  });
});

describe("installGracefulShutdown", () => {
  function setup(options: { slowMs: number; drainMs: number; whenIdle?: () => Promise<void> }) {
    const events: string[] = [];
    // Recorded server-side, when the handler's response is fully written.
    const { drainable, started } = slowServer(options.slowMs, () => events.push("response"));
    const signals = new EventEmitter();
    const step = (name: string, fail = false) => ({
      name,
      run: async () => {
        events.push(name);
        if (fail) throw new Error(`${name} failed`);
      }
    });
    const exited = new Promise<number>((resolve) => {
      installGracefulShutdown({
        server: drainable,
        drainMs: options.drainMs,
        background: { whenIdle: options.whenIdle ?? (async () => {}), pending: 0 },
        steps: [step("broker"), step("pool", true), step("telemetry")],
        logger: silent,
        exit: (code) => {
          events.push(`exit:${code}`);
          resolve(code);
        },
        signals
      });
    });
    return { server: drainable.server, started, signals, events, exited };
  }

  it("answers the in-flight request BEFORE stopping the broker and ending the pool", async () => {
    const { server, started, signals, events, exited } = setup({ slowMs: 60, drainMs: 2_000 });
    const port = await listen(server);
    const inFlight = get(port, "/slow");
    await started;
    signals.emit("SIGTERM");
    assert.equal(await exited, 0);
    assert.equal((await inFlight).body, "done");
    // A failing step (the pool) does not skip the ones after it.
    assert.deepEqual(events, ["response", "broker", "pool", "telemetry", "exit:0"]);
  });

  it("handles SIGINT the same way", async () => {
    const { server, signals, exited } = setup({ slowMs: 0, drainMs: 500 });
    await listen(server);
    signals.emit("SIGINT");
    assert.equal(await exited, 0);
    assert.equal(server.listening, false);
  });

  it("bounds the background drain by the remaining drain window", async () => {
    const { server, signals, events, exited } = setup({
      slowMs: 0,
      drainMs: 50,
      whenIdle: () => new Promise(() => {}) // never idle
    });
    await listen(server);
    signals.emit("SIGTERM");
    assert.equal(await exited, 0);
    assert.deepEqual(events, ["broker", "pool", "telemetry", "exit:0"]);
  });

  it("exits immediately (code 1) on a second signal while draining", async () => {
    const { server, started, signals, events, exited } = setup({ slowMs: 500, drainMs: 500 });
    const port = await listen(server);
    void get(port, "/slow").catch(() => undefined);
    await started;
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    assert.equal(await exited, 1);
    assert.deepEqual(events, ["exit:1"], "teardown never ran: the operator asked to stop now");
    server.closeAllConnections();
  });
});
