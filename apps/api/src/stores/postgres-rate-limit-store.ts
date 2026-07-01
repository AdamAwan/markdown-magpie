import pg from "pg";
import { windowStartFor, type RateLimitResult, type RateLimitStore } from "./rate-limit-store.js";

// Multi-instance-correct fixed-window counter. The increment is a single atomic
// UPSERT so concurrent API instances hitting the same key never lose a count.
// The same statement drops the key's own expired windows, so an active key keeps
// exactly one row; prune() sweeps rows left behind by keys that have gone silent.
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly pool: pg.Pool) {}

  async hit(key: string, windowMs: number, limit: number, now: number): Promise<RateLimitResult> {
    const windowStart = windowStartFor(now, windowMs);
    const windowStartAt = new Date(windowStart);
    const result = await this.pool.query<{ count: number }>(
      `WITH stale AS (
         DELETE FROM rate_limit_counters
          WHERE bucket_key = $1 AND window_start < $2
       ), bumped AS (
         INSERT INTO rate_limit_counters (bucket_key, window_start, count)
         VALUES ($1, $2, 1)
         ON CONFLICT (bucket_key, window_start)
         DO UPDATE SET count = rate_limit_counters.count + 1
         RETURNING count
       )
       SELECT count FROM bumped`,
      [key, windowStartAt]
    );
    const count = result.rows[0]?.count ?? 1;
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

  async prune(olderThan: number): Promise<void> {
    await this.pool.query("DELETE FROM rate_limit_counters WHERE window_start < $1", [new Date(olderThan)]);
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM rate_limit_counters");
  }
}
