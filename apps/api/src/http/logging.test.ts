import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createLogger } from "@magpie/logger";
import { Writable } from "node:stream";
import { requestLogging } from "./logging.js";
import { CORRELATION_HEADER, correlation } from "../platform/correlation.js";

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

test("mints a correlation id, binds it on the logger, and echoes it in the response", async () => {
  const cap = captureLogger();
  const app = new Hono();
  let ambient: string | undefined;
  app.use("*", requestLogging(cap.logger));
  app.get("/thing", (c) => {
    ambient = correlation.current();
    c.get("logger").info("handler ran");
    return c.json({ ok: true });
  });

  const res = await app.request("/thing");
  const echoed = res.headers.get(CORRELATION_HEADER);
  assert.ok(echoed, "expected the response to echo a correlation id");

  const handlerLine = cap.lines().find((l) => l.msg === "handler ran");
  assert.ok(handlerLine);
  // The ambient id, the bound log field, and the echoed header all agree.
  assert.equal(ambient, echoed);
  assert.equal(handlerLine.correlationId, echoed);
});

test("reuses an inbound correlation id so a chain shares one id", async () => {
  const cap = captureLogger();
  const app = new Hono();
  app.use("*", requestLogging(cap.logger));
  app.get("/thing", (c) => {
    c.get("logger").info("handler ran");
    return c.json({ ok: true });
  });

  const res = await app.request("/thing", { headers: { [CORRELATION_HEADER]: "chain-42" } });
  assert.equal(res.headers.get(CORRELATION_HEADER), "chain-42");

  const handlerLine = cap.lines().find((l) => l.msg === "handler ran");
  assert.ok(handlerLine);
  assert.equal(handlerLine.correlationId, "chain-42");
});
