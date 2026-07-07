import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createLogger } from "@magpie/logger";
import { Writable } from "node:stream";
import { HttpError, onError } from "./errors.js";

function captureLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  return {
    logger: createLogger({ level: "info", destination: stream }),
    lines: () => chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  };
}

test("HttpError returns its code without logging at error", async () => {
  const cap = captureLogger();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("logger", cap.logger);
    await next();
  });
  app.onError(onError);
  app.get("/x", () => {
    throw new HttpError(404, "thing_not_found");
  });

  const res = await app.request("/x");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "thing_not_found" });
  assert.equal(cap.lines().filter((l) => l.level === 50).length, 0);
});

test("unexpected error logs at error and returns a generic body", async () => {
  const cap = captureLogger();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("logger", cap.logger);
    await next();
  });
  app.onError(onError);
  app.get("/x", () => {
    throw new Error("boom");
  });

  const res = await app.request("/x");
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "internal_error" });
  const errLine = cap.lines().find((l) => l.level === 50);
  assert.ok(errLine, "expected an error-level log");
});
