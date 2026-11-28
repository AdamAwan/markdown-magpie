import type { EmbeddingProvider } from "@magpie/core";
import { embedPendingSections, type EmbedRetryPolicy } from "../stores/embed-sections.js";
import type { EmbeddingPersistence } from "../stores/knowledge-index.js";
import { logger } from "../logger.js";

export interface BackgroundEmbedderOptions {
  // Delay before re-running a pass that failed (an outage the per-batch retries
  // did not outlast), doubling per consecutive failure up to maxRetryDelayMs.
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  retry?: Partial<EmbedRetryPolicy>;
}

const DEFAULT_INITIAL_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 10 * 60_000;

export class BackgroundEmbedder {
  private inFlight = false;
  private rerunRequested = false;
  private consecutiveFailures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: EmbeddingPersistence | undefined,
    private readonly provider: EmbeddingProvider | undefined,
    private readonly options: BackgroundEmbedderOptions = {}
  ) {}

  async trigger(): Promise<void> {
    if (!this.store || !this.provider) {
      return;
    }
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    this.inFlight = true;
    this.cancelRetry();
    try {
      do {
        this.rerunRequested = false;
        const result = await embedPendingSections({
          store: this.store,
          provider: this.provider,
          retry: this.options.retry
        });
        if (result.embeddedCount > 0 || result.skippedCount > 0) {
          logger.debug(
            { embeddedCount: result.embeddedCount, skippedCount: result.skippedCount, remaining: result.remaining },
            "embedded sections"
          );
        }
      } while (this.rerunRequested);
      this.consecutiveFailures = 0;
    } catch (error) {
      // The provider (or store) failed past the per-batch retries — an outage.
      // Nothing re-triggers the embedder until the next re-index, so schedule
      // the next pass ourselves rather than leaving sections unembedded (and
      // their sections invisible to vector search) indefinitely (IN32).
      this.consecutiveFailures += 1;
      const delayMs = this.retryDelayMs();
      logger.warn(
        { err: error instanceof Error ? error.message : "unknown error", retryInMs: delayMs },
        "background embedding failed; will retry"
      );
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.trigger();
      }, delayMs);
      // Never hold a shutting-down process open for a retry.
      this.retryTimer.unref();
    } finally {
      this.inFlight = false;
    }
  }

  // Cancels a scheduled retry (shutdown, tests).
  stop(): void {
    this.cancelRetry();
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private retryDelayMs(): number {
    const initial = this.options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
    const max = this.options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    return Math.min(max, initial * 2 ** (this.consecutiveFailures - 1));
  }
}
