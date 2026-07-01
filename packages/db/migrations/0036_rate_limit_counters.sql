-- Fixed-window counters for per-principal API rate limiting. One row per
-- (principal-scoped bucket key, window start); the API increments count with an
-- atomic UPSERT so multiple API instances share a single, correct count.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

-- Supports pruning expired windows (DELETE ... WHERE window_start < cutoff).
CREATE INDEX IF NOT EXISTS rate_limit_counters_window_start_idx
  ON rate_limit_counters (window_start);
