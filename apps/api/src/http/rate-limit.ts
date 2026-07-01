import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../context.js";

// The two request classes we throttle at different rates: cheap-but-metered ask
// traffic vs. the expensive manual maintenance triggers.
export type RateLimitTier = "ask" | "trigger";

// Per-principal fixed-window rate limiting. Keyed on the authenticated subject,
// so it can only act when auth is on; with auth disabled (local dev) there is no
// principal to key on and every request passes. Over-limit requests get a 429
// with Retry-After. Every decision is emitted as a structured `rate_limit` log
// event (blocked at warn, allowed at debug) for dashboards — see
// docs/rate-limiting.md for the field schema and example queries.
export function rateLimit(ctx: AppContext, tier: RateLimitTier): MiddlewareHandler {
  return async (c, next) => {
    const settings = ctx.settings.rateLimit;
    if (!settings.enabled) {
      return next();
    }

    const principal = c.get("principal");
    if (!principal) {
      // No identity to attribute the request to; the per-principal limiter cannot
      // apply. (The global AI-capacity guard still protects metered work.)
      return next();
    }

    const limit = tier === "ask" ? settings.askPerWindow : settings.triggerPerWindow;
    const now = Date.now();
    const result = await ctx.stores.rateLimit.hit(`${tier}:${principal.subject}`, settings.windowMs, limit, now);
    const log = c.get("logger");
    const base = {
      event: "rate_limit",
      tier,
      subject: principal.subject,
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
