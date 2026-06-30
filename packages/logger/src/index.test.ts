import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { createLogger } from "./index.js";

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
