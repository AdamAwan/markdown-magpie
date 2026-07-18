import { randomUUID } from "node:crypto";
import {
  isInteractiveJobType,
  jobDefinition,
  queueNameForJob,
  queueNamesForCapabilities,
  type JobCapability,
  type JobError,
  type JobType,
  type JobView
} from "@magpie/jobs";
import { CronExpressionParser } from "cron-parser";
import { injectTraceContext } from "@magpie/telemetry";
import type {
  AdmissionResult,
  DesiredSchedule,
  InFlightCapacity,
  JobBroker,
  JobListFilters,
  ScheduleView
} from "./broker.js";

// Job states pg-boss treats as finished (`state >= 'completed'` in its own enum
// ordering) — see cancel()'s comment for why this matters.
const TERMINAL_JOB_STATES: ReadonlySet<JobView["state"]> = new Set(["completed", "cancelled", "failed"]);

// Test-only in-memory implementation of JobBroker. Backed by an insertion-ordered
// Map. Does NOT read environment variables.
export class FakeJobBroker implements JobBroker {
  private readonly jobs = new Map<string, JobView>();
  private readonly schedules = new Map<string, ScheduleView>();
  private started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  async reset(): Promise<void> {
    this.jobs.clear();
    this.schedules.clear();
  }

  async create(type: JobType, input: unknown): Promise<JobView> {
    const definition = jobDefinition(type);
    const parseResult = definition.inputSchema.safeParse(input);
    if (!parseResult.success) {
      throw new Error(`Invalid input for job type "${type}": ${parseResult.error.message}`);
    }

    const now = new Date().toISOString();
    const job: JobView = {
      id: randomUUID(),
      type,
      queueName: queueNameForJob(type, input),
      deadLetter: false,
      state: "created",
      input: parseResult.data,
      // Mirror the real broker: capture the active trace context (empty and thus
      // omitted when telemetry is disabled) so propagation is exercised under test.
      traceContext: emptyToUndefined(injectTraceContext()),
      retryCount: 0,
      retryLimit: definition.policy.retryLimit,
      expireInSeconds: definition.policy.expireInSeconds,
      createdAt: now,
      updatedAt: now
    };

    this.jobs.set(job.id, job);
    return job;
  }

  // Single-process mirror of the real broker's atomic admission: no lock is
  // needed because JS runs this to completion without interleaving. Counts the
  // in-memory jobs with the same in-flight states, applies the IDENTICAL block
  // rule, and create()s only when admitted.
  async createIfAdmitted(type: JobType, input: unknown, capacity: InFlightCapacity): Promise<AdmissionResult> {
    const inFlight = this.countInFlightSync(capacity.types);
    const reserveInFlight = capacity.reserve ? this.countInFlightSync(capacity.reserve.types) : 0;
    const blocked = capacity.reserve
      ? reserveInFlight >= capacity.reserve.reserved && inFlight >= capacity.limit
      : inFlight >= capacity.limit;
    if (blocked) {
      return { admitted: false, inFlight, ...(capacity.reserve ? { reserveInFlight } : {}) };
    }
    const job = await this.create(type, input);
    return { admitted: true, job, inFlight, ...(capacity.reserve ? { reserveInFlight } : {}) };
  }

  async claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined> {
    const acceptedQueues = new Set(queueNamesForCapabilities(capabilities));

    // Mirror the real broker's interactive lane (#240): among claimable jobs, an
    // interactive-class one (see INTERACTIVE_AI_JOB_TYPES) is claimed ahead of
    // any older background job; within a class, insertion order (FIFO) holds.
    const claimable = [...this.jobs.values()].filter(
      (job) => (job.state === "created" || job.state === "retry") && acceptedQueues.has(job.queueName)
    );
    const job = claimable.find((candidate) => isInteractiveJobType(candidate.type)) ?? claimable[0];
    if (!job) {
      return undefined;
    }

    const now = new Date().toISOString();
    const claimed: JobView = {
      ...job,
      state: "active",
      startedAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, claimed);
    void workerName; // recorded in real implementation; not needed in fake
    return claimed;
  }

  async heartbeat(id: string): Promise<JobView> {
    const job = this.getExisting(id);
    const now = new Date().toISOString();
    // If cancelled, keep cancelled state; otherwise stays active
    const updated: JobView = {
      ...job,
      heartbeatAt: now,
      updatedAt: now
    };
    this.jobs.set(id, updated);
    return updated;
  }

  async complete(id: string, output: unknown): Promise<JobView> {
    const job = this.getExisting(id);
    const now = new Date().toISOString();
    const completed: JobView = {
      ...job,
      state: "completed",
      output,
      completedAt: now,
      updatedAt: now
    };
    this.jobs.set(id, completed);
    return completed;
  }

  async fail(id: string, error: JobError): Promise<JobView> {
    const job = this.getExisting(id);
    // Mirrors pg-boss's failJobsById SQL (`WHERE state < 'completed'`): failing a
    // job that already reached a terminal state is a no-op, not an overwrite.
    // This matters for #161's side-effect replay: completion is persisted before
    // the side-effect fan-out, so when the watcher exhausts its complete() retries
    // on side_effects_failed and falls back to fail(), the completed row (and its
    // paid-for output) must survive untouched.
    if (TERMINAL_JOB_STATES.has(job.state)) {
      return job;
    }
    const now = new Date().toISOString();

    let updated: JobView;
    if (job.retryCount < job.retryLimit) {
      updated = {
        ...job,
        state: "retry",
        retryCount: job.retryCount + 1,
        error,
        updatedAt: now
      };
    } else {
      updated = {
        ...job,
        state: "failed",
        error,
        failedAt: now,
        updatedAt: now
      };
    }

    this.jobs.set(id, updated);
    return updated;
  }

  async cancel(id: string): Promise<JobView> {
    const job = this.getExisting(id);
    // Mirrors pg-boss's cancelJobs SQL (`WHERE state < 'completed'`): cancelling a
    // job that has already reached a terminal state is a no-op, not an overwrite.
    // This matters for the runJobToCompletion timeout-cancel path (#162): a job
    // that completes/fails in the gap between the bounded wait's timeout and the
    // cancel call must keep its real terminal state, not flip to "cancelled".
    if (TERMINAL_JOB_STATES.has(job.state)) {
      return job;
    }
    const now = new Date().toISOString();
    const cancelled: JobView = {
      ...job,
      state: "cancelled",
      cancelledAt: now,
      updatedAt: now
    };
    this.jobs.set(id, cancelled);
    return cancelled;
  }

  async retry(id: string): Promise<JobView> {
    const job = this.getExisting(id);
    if (job.state !== "failed") {
      throw new Error(`Cannot retry job ${id} in state "${job.state}"; only "failed" jobs can be retried`);
    }
    const now = new Date().toISOString();
    const retried: JobView = {
      ...job,
      state: "created",
      error: undefined,
      failedAt: undefined,
      updatedAt: now
    };
    this.jobs.set(id, retried);
    return retried;
  }

  async get(id: string): Promise<JobView | undefined> {
    return this.jobs.get(id);
  }

  async list(filters: JobListFilters): Promise<{ jobs: JobView[]; total: number }> {
    let results = [...this.jobs.values()];

    if (filters.type !== undefined) {
      results = results.filter((job) => job.type === filters.type);
    }
    if (filters.state !== undefined) {
      results = results.filter((job) => job.state === filters.state);
    }
    if (filters.createdAfter !== undefined) {
      const after = filters.createdAfter;
      results = results.filter((job) => job.createdAt > after);
    }

    const total = results.length;

    // Sort newest-first
    results = results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? 200, 200);
    results = results.slice(offset, offset + limit);

    return { jobs: results, total };
  }

  async countInFlight(types: JobType[]): Promise<number> {
    return this.countInFlightSync(types);
  }

  // Shared by countInFlight and createIfAdmitted so both apply the identical
  // in-flight-state predicate — they must never disagree on what counts.
  private countInFlightSync(types: JobType[]): number {
    const wanted = new Set(types);
    let count = 0;
    for (const job of this.jobs.values()) {
      if (wanted.has(job.type) && (job.state === "created" || job.state === "retry" || job.state === "active")) {
        count += 1;
      }
    }
    return count;
  }

  async reconcileSchedules(desired: DesiredSchedule[]): Promise<void> {
    for (const schedule of desired) {
      this.schedules.set(schedule.key, {
        key: schedule.key,
        type: schedule.type,
        cron: schedule.cron,
        enabled: schedule.enabled,
        // Mirror the real broker: an enabled schedule exposes its next fire time
        // (derived from the cron); a disabled one has none.
        nextRunAt: schedule.enabled ? nextRunFor(schedule.cron) : undefined
      });
    }
  }

  async listSchedules(): Promise<ScheduleView[]> {
    return [...this.schedules.values()];
  }

  private getExisting(id: string): JobView {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job not found: ${id}`);
    }
    return job;
  }
}

// A trace carrier is empty when telemetry is disabled; drop it so JobView.traceContext
// stays absent rather than an empty object, matching the real broker.
function emptyToUndefined(carrier: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(carrier).length > 0 ? carrier : undefined;
}

// The next fire time for a cron in UTC, as an ISO string, or undefined when the
// expression cannot be parsed. UTC matches the real broker's default timezone.
function nextRunFor(cron: string): string | undefined {
  try {
    return CronExpressionParser.parse(cron, { tz: "UTC" }).next().toISOString() ?? undefined;
  } catch {
    return undefined;
  }
}
