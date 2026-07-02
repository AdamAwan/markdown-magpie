import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createLogger } from "@magpie/logger";
import { Writable } from "node:stream";
import { requestLogging } from "./logging.js";

function captureLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  const logger = createLogger({ level: "info", destination: stream });
  return {
    logger,
    lines: () =>
      chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  };
}

test("logs one completion line with status and durationMs", async () => {
  const cap = captureLogger();
  const app = new Hono();
  app.use("*", requestLogging(cap.logger));
  app.get("/thing", (c) => c.json({ ok: true }));

  const res = await app.request("/thing");
  assert.equal(res.status, 200);

  const completion = cap.lines().find((l) => l.msg === "request");
  assert.ok(completion, "expected a request completion log");
  assert.equal(completion.status, 200);
  assert.equal(completion.path, "/thing");
  assert.equal(typeof completion.durationMs, "number");
});

test("exposes a request-scoped child logger via c.get", async () => {
  const cap = captureLogger();
  const app = new Hono();
  app.use("*", requestLogging(cap.logger));
  app.get("/thing", (c) => {
    c.get("logger").info("handler ran");
    return c.json({ ok: true });
  });

  await app.request("/thing");
  const handlerLine = cap.lines().find((l) => l.msg === "handler ran");
  assert.ok(handlerLine);
  assert.equal(typeof handlerLine.requestId, "string");
});
