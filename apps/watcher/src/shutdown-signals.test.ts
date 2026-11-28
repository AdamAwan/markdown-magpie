import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { installShutdownSignals, type ForcedExitReason } from "./shutdown-signals.js";

// docs/ai-jobs.md J54: first signal = graceful stop; a second signal, or the
// graceful stop overrunning its timeout, forces exit.

function harness(timeoutMs: number) {
  const signals = new EventEmitter();
  const shutdowns: string[] = [];
  const forced: { reason: ForcedExitReason; signal: string }[] = [];
  installShutdownSignals({
    signals,
    timeoutMs,
    onShutdown: (signal) => shutdowns.push(signal),
    onForcedExit: (reason, signal) => forced.push({ reason, signal })
  });
  return { signals, shutdowns, forced };
}

describe("installShutdownSignals", () => {
  it("starts one graceful stop on SIGTERM", () => {
    const { signals, shutdowns, forced } = harness(10_000);
    signals.emit("SIGTERM");
    assert.deepEqual(shutdowns, ["SIGTERM"]);
    assert.deepEqual(forced, []);
  });

  it("treats SIGINT the same way", () => {
    const { signals, shutdowns } = harness(10_000);
    signals.emit("SIGINT");
    assert.deepEqual(shutdowns, ["SIGINT"]);
  });

  it("forces exit on a second signal without starting a second graceful stop", () => {
    const { signals, shutdowns, forced } = harness(10_000);
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    assert.deepEqual(shutdowns, ["SIGTERM"]);
    assert.deepEqual(forced, [{ reason: "second_signal", signal: "SIGINT" }]);
  });

  it("forces exit when the graceful stop overruns its timeout", async () => {
    const { signals, forced } = harness(10);
    signals.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(forced, [{ reason: "timeout", signal: "SIGTERM" }]);
  });
});
