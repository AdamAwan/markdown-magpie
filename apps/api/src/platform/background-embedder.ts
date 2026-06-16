import type { EmbeddingProvider } from "@magpie/core";
import { embedPendingSections } from "../stores/embed-sections.js";
import type { EmbeddingPersistence } from "../stores/knowledge-index.js";

export class BackgroundEmbedder {
  private inFlight = false;
  private rerunRequested = false;

  constructor(
    private readonly store: EmbeddingPersistence | undefined,
    private readonly provider: EmbeddingProvider | undefined
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
    try {
      do {
        this.rerunRequested = false;
        const result = await embedPendingSections({ store: this.store, provider: this.provider });
        if (result.embeddedCount > 0) {
          console.log(`Embedded ${result.embeddedCount} section(s); ${result.remaining} remaining`);
        }
      } while (this.rerunRequested);
    } catch (error) {
      console.warn(`Background embedding failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      this.inFlight = false;
    }
  }
}
