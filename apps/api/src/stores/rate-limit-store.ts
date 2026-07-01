// Fixed-window request counters backing the API's per-principal rate limiting.
// A "window" is a wall-clock slice of width windowMs anchored at the epoch, so
// every API instance derives the same window boundaries without coordination —
// the shared Postgres row is what makes the count correct across instances (the
// in-memory variant is per-process, for tests and auth-disabled local dev).

export interface RateLimitResult {
  // Whether this hit is within the limit (count after the hit is <= limit).
  allowed: boolean;
  limit: number;
  // The request count for the key in the current window, including this hit.
  count: number;
  // Remaining allowance in the current window (never negative).
  remaining: number;
  // Epoch-ms boundary at which the current window ends and the count resets.
  resetAt: number;
  // Milliseconds until resetAt; 0 when allowed. Drives the Retry-After header.
  retryAfterMs: number;
}

export interface RateLimitStore {
  // Record one request against `key` in the window containing `now` and return
  // the resulting count/allowance. Atomic per key: concurrent hits never lose an
  // increment.
  hit(key: string, windowMs: number, limit: number, now: number): Promise<RateLimitResult>;
  // Remove counters whose window ended before `olderThan` (epoch ms). Optional
  // housekeeping so silent keys don't leave rows around forever.
  prune(olderThan: number): Promise<void>;
  reset(): Promise<void>;
}

// Anchors a timestamp to the start of its fixed window.
export function windowStartFor(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

function toResult(count: number, limit: number, windowStart: number, windowMs: number, now: number): RateLimitResult {
  const resetAt = windowStart + windowMs;
  const allowed = count <= limit;
  return {
    allowed,
    limit,
    count,
    remaining: Math.max(0, limit - count),
    resetAt,
    retryAfterMs: allowed ? 0 : Math.max(0, resetAt - now)
  };
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, { windowStart: number; count: number }>();

  async hit(key: string, windowMs: number, limit: number, now: number): Promise<RateLimitResult> {
    const windowStart = windowStartFor(now, windowMs);
    const existing = this.counters.get(key);
    const count = existing && existing.windowStart === windowStart ? existing.count + 1 : 1;
    this.counters.set(key, { windowStart, count });
    return toResult(count, limit, windowStart, windowMs, now);
  }

  async prune(olderThan: number): Promise<void> {
    for (const [key, entry] of this.counters) {
      if (entry.windowStart < olderThan) {
        this.counters.delete(key);
      }
    }
  }

  async reset(): Promise<void> {
    this.counters.clear();
  }
}
