// The watcher's SIGTERM/SIGINT policy (docs/ai-jobs.md J54). The first signal
// starts a graceful stop (the worker loop aborts its runner and releases the job
// back to the queue — J53); a second signal, or the graceful stop overrunning
// `timeoutMs`, forces exit so a stuck teardown never waits out the container's
// stop grace period into a SIGKILL. Kept apart from main.ts so the policy is
// testable without a real process.

export type ForcedExitReason = "second_signal" | "timeout";

export interface ShutdownSignalOptions {
  // Where SIGTERM/SIGINT arrive; process in production, an emitter in tests.
  signals: Pick<NodeJS.EventEmitter, "on">;
  timeoutMs: number;
  onShutdown: (signal: NodeJS.Signals) => void;
  onForcedExit: (reason: ForcedExitReason, signal: NodeJS.Signals) => void;
}

export function installShutdownSignals(options: ShutdownSignalOptions): void {
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      options.onForcedExit("second_signal", signal);
      return;
    }
    shuttingDown = true;
    // unref: a graceful stop that finishes in time must not be held open by it.
    setTimeout(() => options.onForcedExit("timeout", signal), options.timeoutMs).unref();
    options.onShutdown(signal);
  };
  options.signals.on("SIGTERM", () => onSignal("SIGTERM"));
  options.signals.on("SIGINT", () => onSignal("SIGINT"));
}
