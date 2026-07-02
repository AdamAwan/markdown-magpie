import { randomUUID } from "node:crypto";
import type { Logger } from "@magpie/logger";
import type { JobCapability, JobError, JobView } from "@magpie/jobs";
import { correlation } from "./correlation.js";
import type { WatcherApiClient } from "./http-client.js";
import type { JobRunner } from "./runners/types.js";

export interface WorkerLoopOptions {
  // How long to wait between claim attempts when no job is available.
  pollIntervalMs: number;
  // Invoked once per loop iteration (claimed or idle-poll alike), after the
  // claim/execute cycle settles — including when it threw. This is the
  // liveness signal the health server's /health endpoint reads: a loop stuck
  // inside a single iteration (rather than crashing) stops calling this and
  // /health goes stale. Optional so existing callers/tests are unaffected.
  onTick?: () => void;
}

// The default heartbeat cadence (ms) used when a job carries no heartbeatSeconds.
// Mirrors the @magpie/jobs catalog BASE_POLICY heartbeatSeconds of 60s, halved.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

// The poll/execute loop. It claims a job for the capabilities this watcher
// advertises, dispatches it to the matching runner under an AbortSignal,
// heartbeats while it runs (aborting if the server reports the job cancelled),
// and reports the single terminal outcome (complete or fail). One job at a time.
export class WorkerLoop {
  private running = false;
  private stopping = false;
  private activeController: AbortController | undefined;

  constructor(
    private readonly api: WatcherApiClient,
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
  // promptly without leaving the job claimed.
  async stop(): Promise<void> {
    this.stopping = true;
    this.activeController?.abort(new Error("watcher shutting down"));
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
    // Continue the enqueueing request's chain when the job carries a correlation
    // id; mint one for jobs that originated outside a request (e.g. scheduled
    // fires) so this execution and the API callbacks it makes still share an id.
    // Binding it in the store lets the HTTP client forward it on every callback
    // without threading it through each runner.
    const correlationId = job.correlationId ?? randomUUID();
    await correlation.run(correlationId, () => this.runInScope(job, correlationId));
  }

  private async runInScope(job: JobView, correlationId: string): Promise<void> {
    const startedAt = Date.now();
    const log = this.logger.child({ jobId: job.id, jobType: job.type, correlationId });
    log.info("job claimed");

    const runner = this.runners.find((candidate) => candidate.supports(job.type));
    if (!runner) {
      log.error("no runner supports job type; failing job");
      await this.api.fail(job.id, this.toJobError(job, new Error(`No runner supports job type ${job.type}`)));
      return;
    }

    const controller = new AbortController();
    this.activeController = controller;
    const heartbeat = this.startHeartbeat(job, controller);

    try {
      const output = await runner.run(job, controller.signal);
      // A cancellation reaches a terminal state server-side; don't try to
      // complete a job the server already moved out from under us.
      if (controller.signal.aborted) {
        log.info({ durationMs: Date.now() - startedAt, outcome: "cancelled" }, "job cancelled");
        return;
      }
      await this.api.complete(job.id, output);
      log.info({ durationMs: Date.now() - startedAt, outcome: "completed" }, "job done");
    } catch (error) {
      if (controller.signal.aborted) {
        // Aborted by cancellation or shutdown — the job is (or will be) terminal
        // server-side, so do not record a redundant failure.
        log.info({ durationMs: Date.now() - startedAt, outcome: "cancelled" }, "job cancelled");
        return;
      }
      log.error({ durationMs: Date.now() - startedAt, outcome: "failed", err: error }, "job failed");
      await this.api.fail(job.id, this.toJobError(job, error));
    } finally {
      heartbeat.stop();
      this.activeController = undefined;
    }
  }

  // Polls the server heartbeat on a cadence of half the job's heartbeat window.
  // A cancelled response aborts the active controller so the runner can wind down.
  private startHeartbeat(job: JobView, controller: AbortController): { stop(): void } {
    const intervalMs = heartbeatIntervalMs(job);
    const timer = setInterval(() => {
      void this.api
        .heartbeat(job.id)
        .then((result) => {
          if (result.cancelled) {
            this.logger.info({ jobId: job.id }, "job cancellation requested by server; aborting");
            controller.abort(new Error("job cancelled"));
          }
        })
        .catch(() => {
          // A transient heartbeat failure must not crash the loop; the job's
          // expiry on the server side remains the backstop.
        });
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
    return Math.max(1, (seconds * 1000) / 2);
  }
  return DEFAULT_HEARTBEAT_INTERVAL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
