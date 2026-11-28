import type { AiUsage } from "@magpie/core";
import type { Logger } from "@magpie/logger";
import type { JobCapability, JobError, JobView } from "@magpie/jobs";
import { recordException, recordJobDuration, recordJobFinished, runJobSpan } from "@magpie/telemetry";
import type { WorkerLoopApiClient } from "./http-client.js";
import type { JobRunner } from "./runners/types.js";
import { addAiUsage } from "./usage.js";

export interface WorkerLoopOptions {
  // How long to wait between claim attempts when no job is available.
  pollIntervalMs: number;
  // The liveness signal the health server's /health endpoint reads. Invoked
  // once per loop iteration (claimed or idle-poll alike), after the
  // claim/execute cycle settles — including when it threw — AND after every
  // per-job heartbeat round trip settles, so a job running longer than the
  // staleness threshold keeps the watcher live (J55). A loop that is wedged
  // (neither polling nor heartbeating) stops calling this and /health goes
  // stale. Optional so existing callers/tests are unaffected.
  onTick?: () => void;
  // How long (ms) a runner aborted for shutdown gets to wind down before the
  // loop stops waiting for it and releases the job anyway (J53). Default 5s.
  shutdownGraceMs?: number;
  // Abort deadline (ms) for the shutdown release call itself. Default 5s.
  releaseTimeoutMs?: number;
}

// The default heartbeat cadence (ms) used when a job carries no heartbeatSeconds.
// A quarter of the @magpie/jobs catalog BASE_POLICY heartbeatSeconds of 120s.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;

// The abort reason stop() uses, so the loop can tell a shutdown (release the job
// back to the queue) from a server-side cancellation (the job is already
// terminal; do nothing) on the same AbortSignal.
class WatcherShutdownError extends Error {
  constructor() {
    super("watcher shutting down");
    this.name = "WatcherShutdownError";
  }
}

// The poll/execute loop. It claims a job for the capabilities this watcher
// advertises, dispatches it to the matching runner under an AbortSignal,
// heartbeats while it runs (aborting if the server reports the job cancelled),
// and reports the single terminal outcome (complete or fail). One job at a time.
export class WorkerLoop {
  private running = false;
  private stopping = false;
  private activeController: AbortController | undefined;

  constructor(
    private readonly api: WorkerLoopApiClient,
    private readonly runners: readonly JobRunner[],
    private readonly capabilities: JobCapability[],
    private readonly workerName: string,
    private readonly logger: Logger,
    private readonly options: WorkerLoopOptions
  ) {}

  // Runs claim/execute cycles until stop() is called.
  async run(): Promise<void> {
    this.running = true;
    while (!this.stopping) {
      let claimed = false;
      try {
        claimed = await this.tick();
      } catch (error) {
        // A claim or terminal-transition error (a transient 5xx, or a 401 before
        // the watcher's service credential is in place) must NOT crash the
        // process. Log it and fall through to the poll-interval backoff so the
        // next cycle retries — otherwise a misconfigured token turns into a
        // tight container restart loop.
        if (!this.stopping) {
          this.logger.error({ err: error }, "watcher poll failed");
        }
      }
      this.options.onTick?.();
      if (!claimed && !this.stopping) {
        await sleep(this.options.pollIntervalMs);
      }
    }
    this.running = false;
  }

  // Requests shutdown and aborts any in-flight runner so the process can exit
  // promptly. The aborted job is released back to the queue (not failed, not
  // left claimed) by runInScope — see J53. run() resolves once that is done.
  async stop(): Promise<void> {
    this.stopping = true;
    this.activeController?.abort(new WatcherShutdownError());
  }

  // One claim-and-(maybe)-execute cycle. Returns true if a job was claimed.
  // Exposed for tests and reused by run().
  async tick(): Promise<boolean> {
    const job = await this.api.claim(this.workerName, this.capabilities);
    if (!job) {
      return false;
    }
    await this.execute(job);
    return true;
  }

  private async execute(job: JobView): Promise<void> {
    // Run the job inside a span parented on the enqueueing request's trace context
    // (carried across the queue on job.traceContext), so this execution and the API
    // callbacks it makes join that trace. A no-op when telemetry is disabled.
    await runJobSpan("job.execute", { "job.id": job.id, "job.type": job.type }, job.traceContext, () =>
      this.runInScope(job)
    );
  }

  private async runInScope(job: JobView): Promise<void> {
    const startedAt = Date.now();
    // trace_id/span_id are stamped onto every line by the logger's mixin (this runs
    // inside the job span), so only the job identity is bound here.
    const log = this.logger.child({ jobId: job.id, jobType: job.type });
    log.info("job claimed");

    // stop() landed while the claim was in flight, before there was a runner to
    // abort: the job is ours now, so hand it straight back rather than start it.
    if (this.stopping) {
      await this.release(job, log, 0);
      return;
    }

    const runner = this.runners.find((candidate) => candidate.supports(job.type));
    if (!runner) {
      log.error("no runner supports job type; failing job");
      const error = new Error(`No runner supports job type ${job.type}`);
      recordException(error);
      await this.api.fail(job, this.toJobError(job, error));
      this.recordOutcome(job, "failed", Date.now() - startedAt);
      return;
    }

    const controller = new AbortController();
    this.activeController = controller;
    const heartbeat = this.startHeartbeat(job, controller);

    // The run's provider-reported token usage, summed across every model call
    // the runner reports (#241). Stays undefined when nothing was reported
    // (CLI providers, non-AI jobs), so the completion carries no usage field.
    let usage: AiUsage | undefined;
    // Whether the runner itself settled with an output. Only an interrupted RUN
    // is released on shutdown; a completion POST that failed afterwards is an
    // ordinary failure, handled as one.
    let producedOutput = false;
    try {
      const output = await untilShutdownGraceEnds(
        runner.run(job, controller.signal, (reading) => {
          usage = addAiUsage(usage, reading);
        }),
        controller.signal,
        this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
      );
      producedOutput = true;
      const durationMs = Date.now() - startedAt;
      // A runner that resolves after a shutdown abort may have returned a
      // partial, wound-down result; it cannot be told apart from a finished one,
      // so it is released (re-run, no retry spent) rather than completed.
      if (isShutdown(controller.signal)) {
        await this.release(job, log, durationMs);
        return;
      }
      // A cancellation reaches a terminal state server-side; don't try to
      // complete a job the server already moved out from under us.
      if (controller.signal.aborted) {
        log.info({ durationMs, outcome: "cancelled" }, "job cancelled");
        this.recordOutcome(job, "cancelled", durationMs);
        return;
      }
      // The runner's aiIdentity (provider + configured model) rides every
      // completion it produces — even usage-less ones (CLI providers), where it
      // marks WHICH model ran unmetered rather than implying the run was free.
      await this.api.complete(job, output, usage, runner.aiIdentity);
      log.info({ durationMs, outcome: "completed" }, "job done");
      this.recordOutcome(job, "completed", durationMs);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (!producedOutput && isShutdown(controller.signal)) {
        // Interrupted by our own shutdown, not by a fault in the job: hand it
        // back to the queue so the next watcher runs it without a retry spent.
        await this.release(job, log, durationMs);
        return;
      }
      if (controller.signal.aborted && !isShutdown(controller.signal)) {
        // Aborted by a server-side cancellation — the job is already terminal
        // server-side, so do not record a redundant failure.
        log.info({ durationMs, outcome: "cancelled" }, "job cancelled");
        this.recordOutcome(job, "cancelled", durationMs);
        return;
      }
      log.error({ durationMs, outcome: "failed", err: error }, "job failed");
      recordException(error);
      this.recordOutcome(job, "failed", durationMs);
      await this.api.fail(job, this.toJobError(job, error));
    } finally {
      heartbeat.stop();
      this.activeController = undefined;
    }
  }

  // Releases a job this watcher was interrupted on by shutdown (J53). Bounded,
  // and best-effort: if the API is unreachable too (it may be restarting in the
  // same deploy), the job stays active and the server's heartbeat-expiry sweep
  // remains the backstop — the pre-release behaviour, which spends a retry.
  private async release(job: JobView, log: Logger, durationMs: number): Promise<void> {
    try {
      await this.api.release(job, AbortSignal.timeout(this.options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS));
      log.info({ durationMs, outcome: "released" }, "job released to the queue for shutdown");
    } catch (error) {
      log.warn(
        { durationMs, outcome: "released", err: error },
        "could not release job on shutdown; it stays claimed until its heartbeat expires"
      );
    }
    this.recordOutcome(job, "released", durationMs);
  }

  // Records the job's outcome as metrics (a no-op when telemetry is off).
  // "released" is not terminal — the job runs again — but is counted so a
  // deploy's interrupted work is visible.
  private recordOutcome(
    job: JobView,
    outcome: "completed" | "failed" | "cancelled" | "released",
    durationMs: number
  ): void {
    recordJobFinished(job.type, outcome);
    recordJobDuration(job.type, outcome, durationMs);
  }

  // Polls the server heartbeat on a cadence of a quarter of the job's heartbeat
  // window, so three lost beats in a row still keep the claim (J60). It keeps
  // beating until the job's terminal report is done — including while
  // complete() retries through an API outage. A reply saying this attempt no
  // longer holds the job (cancelled, failed, completed, or re-queued after the
  // claim lapsed) aborts the active controller: the runner winds down and the
  // loop reports nothing further.
  private startHeartbeat(job: JobView, controller: AbortController): { stop(): void } {
    const intervalMs = heartbeatIntervalMs(job);
    const timer = setInterval(() => {
      void this.api
        .heartbeat(job)
        .then((result) => {
          if (result.cancelled) {
            this.logger.info({ jobId: job.id }, "job cancellation requested by server; aborting");
            controller.abort(new Error("job cancelled"));
          } else if (result.active === false) {
            this.logger.warn({ jobId: job.id }, "job no longer held by this watcher; aborting");
            controller.abort(new Error("job no longer held"));
          }
        })
        .catch(() => {
          // A transient heartbeat failure must not crash the loop; the job's
          // expiry on the server side remains the backstop.
        })
        // Liveness (J55): a heartbeat that settled — even one that failed, as an
        // erroring claim does in run() — proves the loop is not wedged, so a job
        // longer than the /health staleness threshold does not read as dead.
        .finally(() => this.options.onTick?.());
    }, intervalMs);
    return { stop: () => clearInterval(timer) };
  }

  private toJobError(job: JobView, error: unknown): JobError {
    return {
      code: "runner_failed",
      message: error instanceof Error ? error.message : "Unknown runner failure",
      category: "internal",
      executor: this.workerName,
      details: { jobType: job.type }
    };
  }

  isRunning(): boolean {
    return this.running;
  }
}

function heartbeatIntervalMs(job: JobView): number {
  const seconds = job.heartbeatSeconds;
  if (typeof seconds === "number" && seconds > 0) {
    return Math.max(1, (seconds * 1000) / 4);
  }
  return DEFAULT_HEARTBEAT_INTERVAL_MS;
}

function isShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof WatcherShutdownError;
}

// Settles with the runner's own outcome — unless a SHUTDOWN abort has given the
// runner `graceMs` to wind down and it still has not, in which case it rejects
// with the shutdown reason and the runner is abandoned (its eventual outcome is
// swallowed here, so it can never surface as an unhandled rejection). A runner
// that honours its signal settles well inside the grace; this only bounds one
// that does not, so a stuck runner cannot hold the watcher past its container's
// stop grace period and turn the release into a SIGKILL. A cancellation abort
// leaves the runner to settle on its own, as before.
function untilShutdownGraceEnds<T>(work: Promise<T>, signal: AbortSignal, graceMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (isShutdown(signal)) {
        timer = setTimeout(() => reject(signal.reason), graceMs);
      }
    };
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    work.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error);
      }
    );
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
