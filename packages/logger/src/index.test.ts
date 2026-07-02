import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { createFatalHandler, createLogger, installCrashHandlers } from "./index.js";

// Collects each JSON log line written to the logger's destination.
function captureSink(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
  };
}

test("emits a JSON line with message and bound base fields", () => {
  const sink = captureSink();
  const logger = createLogger({ level: "info", base: { service: "test" }, destination: sink.stream });

  logger.info({ jobId: "abc" }, "did a thing");

  const [line] = sink.lines();
  assert.equal(line.msg, "did a thing");
  assert.equal(line.service, "test");
  assert.equal(line.jobId, "abc");
  assert.equal(line.level, 30); // pino numeric level for info
});

test("filters lines below the configured level", () => {
  const sink = captureSink();
  const logger = createLogger({ level: "warn", destination: sink.stream });

  logger.info("suppressed");
  logger.warn("kept");

  const lines = sink.lines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, "kept");
});

test("child loggers bind fields onto every line", () => {
  const sink = captureSink();
  const logger = createLogger({ level: "info", destination: sink.stream });
  const child = logger.child({ requestId: "req-1" });

  child.info("first");
  child.info("second");

  const lines = sink.lines();
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.requestId === "req-1"));
});

test("installCrashHandlers registers a handler for both fatal process events", () => {
  const sink = captureSink();
  const logger = createLogger({ level: "info", destination: sink.stream });
  const events = ["uncaughtException", "unhandledRejection"] as const;
  const before = new Map(events.map((event) => [event, process.listeners(event)]));

  installCrashHandlers(logger, () => undefined);
  try {
    for (const event of events) {
      assert.equal(process.listenerCount(event), before.get(event)!.length + 1);
    }
  } finally {
    // Remove exactly the listeners this call added so the global process object
    // isn't left with a test-scoped handler that would fire (and exit) on a later
    // unrelated throw elsewhere in the suite.
    for (const event of events) {
      for (const listener of process.listeners(event).filter((l) => !before.get(event)!.includes(l))) {
        process.off(event, listener as (...args: unknown[]) => void);
      }
    }
  }
});

// The exit path runs inside the fire-once flush callback; resolve a promise from
// the injected exit so the assertion waits for it deterministically.
async function runFatal(
  event: "uncaughtException" | "unhandledRejection",
  value: unknown
): Promise<{ exitCode: number | undefined; lines: Record<string, unknown>[] }> {
  const sink = captureSink();
  const logger = createLogger({ level: "info", destination: sink.stream });
  let exitCode: number | undefined;
  let resolveExit: () => void;
  const exited = new Promise<void>((resolve) => (resolveExit = resolve));

  const handle = createFatalHandler(logger, (code) => {
    exitCode = code;
    resolveExit();
  });
  handle(event, value);
  await exited;
  return { exitCode, lines: sink.lines() };
}

test("an uncaught exception is logged fatally with context, then exits non-zero", async () => {
  const { exitCode, lines } = await runFatal("uncaughtException", new Error("boom"));

  assert.equal(exitCode, 1);
  const fatal = lines.find((line) => line.level === 60);
  assert.ok(fatal, "expected a fatal log line");
  assert.equal(fatal.event, "uncaughtException");
  assert.equal((fatal.err as { message?: string }).message, "boom");
});

test("a non-Error unhandled rejection is normalized and still logged and exited", async () => {
  // A rejected non-Error (e.g. a bare string) must not throw inside the handler.
  const { exitCode, lines } = await runFatal("unhandledRejection", "nope");

  assert.equal(exitCode, 1);
  const fatal = lines.find((line) => line.level === 60);
  assert.ok(fatal, "expected a fatal log line");
  assert.equal(fatal.event, "unhandledRejection");
  assert.match((fatal.err as { message?: string }).message ?? "", /nope/);
});

test("the fatal handler exits only once even if invoked repeatedly", async () => {
  const sink = captureSink();
  const logger = createLogger({ level: "info", destination: sink.stream });
  let exitCalls = 0;
  let resolveExit: () => void;
  const exited = new Promise<void>((resolve) => (resolveExit = resolve));
  const handle = createFatalHandler(logger, () => {
    exitCalls += 1;
    resolveExit();
  });

  handle("uncaughtException", new Error("first"));
  handle("uncaughtException", new Error("second"));
  await exited;

  assert.equal(exitCalls, 1);
  assert.equal(sink.lines().filter((line) => line.level === 60).length, 1);
});
