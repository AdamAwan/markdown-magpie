import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { rateLimit, type RateLimitTier } from "./rate-limit.js";
import { makeTestContext } from "../test-support/context.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";

const PRINCIPAL: Principal = { subject: "user-1", scopes: [], payload: {} };

// Builds a minimal app that stamps the request logger (normally set by
// requestLogging) and, optionally, an authenticated principal, then applies the
// rate-limit middleware to POST /x.
function appWith(ctx: AppContext, tier: RateLimitTier, principal?: Principal): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("logger", logger);
    if (principal) {
      c.set("principal", principal);
    }
    await next();
  });
  app.post("/x", rateLimit(ctx, tier), (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimit middleware", () => {
  it("allows up to the limit then returns 429 with Retry-After", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.askPerWindow = 2;
    const app = appWith(ctx, "ask", PRINCIPAL);

    const first = await app.request("/x", { method: "POST" });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("RateLimit-Limit"), "2");
    assert.equal(first.headers.get("RateLimit-Remaining"), "1");

    const second = await app.request("/x", { method: "POST" });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("RateLimit-Remaining"), "0");

    const third = await app.request("/x", { method: "POST" });
    assert.equal(third.status, 429);
    assert.deepEqual(await third.json(), { error: "rate_limited" });
    assert.ok(third.headers.get("Retry-After"), "429 carries a Retry-After header");
  });

  it("keys per principal, so a second caller has its own budget", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.askPerWindow = 1;

    const appA = appWith(ctx, "ask", { subject: "a", scopes: [], payload: {} });
    const appB = appWith(ctx, "ask", { subject: "b", scopes: [], payload: {} });

    assert.equal((await appA.request("/x", { method: "POST" })).status, 200);
    assert.equal((await appA.request("/x", { method: "POST" })).status, 429);
    // Different subject shares the same store but a distinct bucket key.
    assert.equal((await appB.request("/x", { method: "POST" })).status, 200);
  });

  it("no-ops when there is no principal (auth disabled)", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.askPerWindow = 1;
    const app = appWith(ctx, "ask"); // no principal set

    for (let i = 0; i < 5; i += 1) {
      assert.equal((await app.request("/x", { method: "POST" })).status, 200);
    }
  });

  it("no-ops when rate limiting is disabled", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.enabled = false;
    ctx.settings.rateLimit.askPerWindow = 1;
    const app = appWith(ctx, "ask", PRINCIPAL);

    for (let i = 0; i < 5; i += 1) {
      assert.equal((await app.request("/x", { method: "POST" })).status, 200);
    }
  });

  it("applies the trigger tier's separate limit", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.triggerPerWindow = 1;
    const app = appWith(ctx, "trigger", PRINCIPAL);

    assert.equal((await app.request("/x", { method: "POST" })).status, 200);
    assert.equal((await app.request("/x", { method: "POST" })).status, 429);
  });
});
