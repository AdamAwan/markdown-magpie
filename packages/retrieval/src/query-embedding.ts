import type { EmbeddingProvider } from "@magpie/core";
import { ProviderRequestError } from "./http.js";

// Request-path embedding (docs/ai-jobs.md J86). Query-time retrieval and flow
// routing embed one short text while a caller waits, and both already degrade
// without a vector (retrieval falls back to keyword-only, routing abstains to the
// chat router). So on that path an embedding provider that is down must fail
// FAST: a short per-call timeout, and a circuit breaker that stops calling it at
// all for a cooldown after repeated failures — instead of every ask stalling for
// the indexing-sized timeout before degrading anyway. Background indexing keeps
// its own provider instance with the long timeout and no breaker.

/** Per-call timeout for a request-path embedding (one short query text). */
export const DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS = 5_000;

export interface EmbeddingCircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold?: number;
  /** How long an open circuit fails fast before letting one trial call through. */
  cooldownMs?: number;
  /** Test seam for the clock. */
  now?: () => number;
  /** Observes open/close transitions (the API logs them). */
  onStateChange?: (event: { state: "open" | "closed"; error?: unknown }) => void;
}

export const DEFAULT_EMBEDDING_CIRCUIT_FAILURE_THRESHOLD = 3;
export const DEFAULT_EMBEDDING_CIRCUIT_COOLDOWN_MS = 30_000;

// A 4xx that describes THIS request (malformed, too large, unprocessable) says
// nothing about the provider's health, so it must not trip the breaker for every
// other caller. Everything else — timeouts, connection failures, 429, 5xx, an
// auth/config 4xx, a malformed response — counts.
const REQUEST_SPECIFIC_STATUSES = new Set([400, 413, 422]);

function countsAgainstProvider(error: unknown): boolean {
  return !(
    error instanceof ProviderRequestError &&
    error.status !== undefined &&
    REQUEST_SPECIFIC_STATUSES.has(error.status)
  );
}

// Closed → (failureThreshold consecutive failures) → open: every call fails at
// once with a ProviderRequestError of kind "circuit_open" carrying the remaining
// cooldown as retryAfterMs. After the cooldown the next call is a half-open
// trial: success closes the circuit, failure re-opens it for another cooldown.
// Only one trial is in flight at a time; concurrent callers keep failing fast.
export class EmbeddingCircuitBreaker implements EmbeddingProvider {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onStateChange?: EmbeddingCircuitBreakerOptions["onStateChange"];
  private consecutiveFailures = 0;
  private openUntil: number | undefined;
  private trialInFlight = false;

  constructor(
    private readonly inner: EmbeddingProvider,
    options: EmbeddingCircuitBreakerOptions = {}
  ) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_EMBEDDING_CIRCUIT_FAILURE_THRESHOLD);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_EMBEDDING_CIRCUIT_COOLDOWN_MS);
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  get state(): "closed" | "open" | "half-open" {
    if (this.openUntil === undefined) {
      return "closed";
    }
    return this.now() < this.openUntil ? "open" : "half-open";
  }

  async embed(texts: string[]): Promise<number[][]> {
    const state = this.state;
    if (state === "open" || (state === "half-open" && this.trialInFlight)) {
      const remaining = Math.max(0, (this.openUntil ?? this.now()) - this.now());
      throw new ProviderRequestError(
        `Embedding provider circuit is open after ${this.consecutiveFailures} consecutive failure(s); ` +
          `skipping the call for ${Math.ceil(remaining / 1000)}s`,
        { label: "Embedding provider", kind: "circuit_open", retryAfterMs: remaining }
      );
    }
    const isTrial = state === "half-open";
    if (isTrial) {
      this.trialInFlight = true;
    }
    try {
      const vectors = await this.inner.embed(texts);
      this.recordSuccess();
      return vectors;
    } catch (error) {
      if (countsAgainstProvider(error)) {
        this.recordFailure(error, isTrial);
      }
      throw error;
    } finally {
      if (isTrial) {
        this.trialInFlight = false;
      }
    }
  }

  private recordSuccess(): void {
    const wasOpen = this.openUntil !== undefined;
    this.consecutiveFailures = 0;
    this.openUntil = undefined;
    if (wasOpen) {
      this.onStateChange?.({ state: "closed" });
    }
  }

  private recordFailure(error: unknown, isTrial: boolean): void {
    this.consecutiveFailures += 1;
    if (isTrial || this.consecutiveFailures >= this.failureThreshold) {
      const wasOpen = this.openUntil !== undefined;
      this.openUntil = this.now() + this.cooldownMs;
      if (!wasOpen) {
        this.onStateChange?.({ state: "open", error });
      }
    }
  }
}
