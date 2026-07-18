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

  it("still throttles when there is no principal, via a shared anonymous bucket", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.askPerWindow = 1;
    const app = appWith(ctx, "ask"); // no principal set

    // Under app.request() there is no socket peer, so all anonymous requests
    // collapse to the single "anon:unknown" bucket rather than bypassing (#293).
    assert.equal((await app.request("/x", { method: "POST" })).status, 200);
    assert.equal((await app.request("/x", { method: "POST" })).status, 429);
  });

  it("keys anonymous requests per client IP when the forwarded header is trusted", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.askPerWindow = 1;
    ctx.settings.rateLimit.trustForwardedFor = true;
    const app = appWith(ctx, "ask"); // no principal

    const from = (ip: string) => app.request("/x", { method: "POST", headers: { "x-forwarded-for": ip } });

    // First IP spends its single-request budget, then is throttled...
    assert.equal((await from("203.0.113.1")).status, 200);
    assert.equal((await from("203.0.113.1")).status, 429);
    // ...while a different client IP has its own budget.
    assert.equal((await from("203.0.113.2")).status, 200);
  });

  it("ignores the forwarded header unless the proxy is trusted", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.askPerWindow = 1;
    // trustForwardedFor defaults to false, so a spoofed XFF can't mint fresh
    // buckets — all anonymous traffic shares the socket-derived (here "unknown")
    // bucket and a second request is throttled regardless of the header.
    const app = appWith(ctx, "ask");
    const from = (ip: string) => app.request("/x", { method: "POST", headers: { "x-forwarded-for": ip } });

    assert.equal((await from("203.0.113.1")).status, 200);
    assert.equal((await from("203.0.113.2")).status, 429);
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
