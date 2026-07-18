import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { AppContext } from "../context.js";

// The two request classes we throttle at different rates: cheap-but-metered ask
// traffic vs. the expensive manual maintenance triggers.
export type RateLimitTier = "ask" | "trigger";

// Fixed-window rate limiting. Keys on the authenticated subject when auth is on;
// when there is no principal (auth disabled, or a route that somehow slipped past
// auth) it falls back to a per-client-IP key so the request is still throttled
// rather than silently unlimited (#293). Over-limit requests get a 429 with
// Retry-After. Every decision is emitted as a structured `rate_limit` log event
// (blocked at warn, allowed at debug) for dashboards — see docs/rate-limiting.md
// for the field schema and example queries.
export function rateLimit(ctx: AppContext, tier: RateLimitTier): MiddlewareHandler {
  return async (c, next) => {
    const settings = ctx.settings.rateLimit;
    if (!settings.enabled) {
      return next();
    }

    const principal = c.get("principal");
    // Prefer the verified subject; otherwise attribute the request to its client
    // IP (or a single shared "anon" bucket when the IP is unknowable) so an
    // unauthenticated route can't bypass the limiter entirely.
    const subject = principal ? principal.subject : anonymousSubject(c, settings.trustForwardedFor);

    const limit = tier === "ask" ? settings.askPerWindow : settings.triggerPerWindow;
    const now = Date.now();
    const result = await ctx.stores.rateLimit.hit(`${tier}:${subject}`, settings.windowMs, limit, now);
    const log = c.get("logger");
    const base = {
      event: "rate_limit",
      tier,
      subject,
      limit: result.limit,
      count: result.count,
      remaining: result.remaining,
      windowMs: settings.windowMs
    };

    // Standard RateLimit-* headers so well-behaved clients can self-pace.
    c.header("RateLimit-Limit", String(result.limit));
    c.header("RateLimit-Remaining", String(result.remaining));
    c.header("RateLimit-Reset", String(Math.max(0, Math.ceil((result.resetAt - now) / 1000))));

    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      c.header("Retry-After", String(retryAfterSeconds));
      log.warn({ ...base, decision: "blocked", retryAfterSeconds }, "rate limit exceeded");
      return c.json({ error: "rate_limited" }, 429);
    }

    log.debug({ ...base, decision: "allowed" }, "rate limit ok");
    await next();
  };
}

// Bucket for a request with no authenticated principal. Prefers the client IP so
// distinct anonymous callers keep distinct budgets; when the IP can't be resolved
// (no socket info under the test/`fetch` harness) it collapses to one shared
// "anon" bucket — coarse, but still a real limit rather than the old full bypass.
// The `ip:`/`anon:` namespace keeps these keys from colliding with real (OIDC)
// subjects.
function anonymousSubject(c: Context, trustForwardedFor: boolean): string {
  const ip = clientIp(c, trustForwardedFor);
  return ip ? `anon:ip:${ip}` : "anon:unknown";
}

// Best-effort client IP. Only honours `X-Forwarded-For` (the left-most, i.e.
// original-client, entry) when explicitly configured to trust the upstream proxy
// — otherwise a client could spoof the header to dodge or poison the limit. Falls
// back to the raw socket peer address, which is `undefined` when the app is driven
// via `app.request()` (tests) rather than a listening node server.
function clientIp(c: Context, trustForwardedFor: boolean): string | undefined {
  if (trustForwardedFor) {
    const forwarded = c.req.header("x-forwarded-for");
    const original = forwarded?.split(",")[0]?.trim();
    if (original) {
      return original;
    }
  }
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}
