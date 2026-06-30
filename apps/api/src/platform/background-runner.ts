// Runs work off the request thread. HTTP handlers hand long jobs (git fetches,
// re-indexing, model calls) here so the response returns immediately while the
// work continues in-process. Errors are logged, never rethrown, so a failed
// background job can't surface as an unhandled rejection or crash the process.
//
// This is in-process and best-effort: tasks do not survive a restart. Long-lived
// work that must be durable belongs on the AI job queue (watcher) or a scheduled
// task instead — this is for the tail of an already-started request.
import { logger } from "../logger.js";

export class BackgroundRunner {
  private readonly inFlight = new Set<Promise<void>>();

  // Schedule `work` to run in the background. Returns immediately. The label is
  // only used for diagnostics in the failure log.
  run(label: string, work: () => Promise<void>): void {
    const task = (async () => {
      try {
        await work();
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        logger.warn({ label, err: message }, "background task failed");
      }
    })();

    this.inFlight.add(task);
    void task.finally(() => {
      this.inFlight.delete(task);
    });
  }

  // Number of tasks currently running. Exposed for diagnostics/tests.
  get pending(): number {
    return this.inFlight.size;
  }

  // Resolves once every task scheduled *before this call* has settled. Tasks
  // started afterwards are not awaited. Used by tests to observe completion and
  // by graceful shutdown to let in-flight work finish.
  async whenIdle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }
}
