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
import {
  JobNotFoundError,
  type AdmissionResult,
  type DesiredSchedule,
  type HeartbeatResult,
  type InFlightCapacity,
  type JobAttemptFence,
  type JobBroker,
  type JobListFilters,
  type JobMatch,
  type ScheduleView
} from "./broker.js";

// Job states pg-boss treats as finished (`state >= 'completed'` in its own enum
// ordering) — see cancel()'s comment for why this matters.
const TERMINAL_JOB_STATES: ReadonlySet<JobView["state"]> = new Set(["completed", "cancelled", "failed"]);

// Not-yet-finished states, as the real broker's in-flight SQL counts them
// (created | retry | active; `blocked` is a created/retry job pg-boss holds back).
const IN_FLIGHT_JOB_STATES: ReadonlySet<JobView["state"]> = new Set(["created", "retry", "active", "blocked"]);

// One field of a job's stored input, read without trusting its shape.
function inputField(input: unknown, field: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;
  return Object.entries(input).find(([key]) => key === field)?.[1];
}

// Test-only in-memory implementation of JobBroker. Backed by an insertion-ordered
// Map. Does NOT read environment variables.
export class FakeJobBroker implements JobBroker {
  private readonly jobs = new Map<string, JobView>();
  private readonly schedules = new Map<string, ScheduleView>();
  private readonly settlements = new Map<string, "claimed" | "settled">();
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
    const inFlight = this.countInFlightSync(capacity.types, capacity.servedCapabilities);
    const reserveInFlight = capacity.reserve
      ? this.countInFlightSync(capacity.reserve.types, capacity.servedCapabilities)
      : 0;
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
      heartbeatAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, claimed);
    void workerName; // recorded in real implementation; not needed in fake
    return claimed;
  }

  // Mirrors pg-boss's touch(): only an active row (of the fenced attempt, when
  // given) is refreshed, and `active` reports whether it was.
  async heartbeat(id: string, fence: JobAttemptFence = {}): Promise<HeartbeatResult> {
    const job = this.getExisting(id);
    if (!holdsAttempt(job, fence)) {
      return { job, active: false };
    }
    const now = new Date().toISOString();
    const updated: JobView = {
      ...job,
      heartbeatAt: now,
      updatedAt: now
    };
    this.jobs.set(id, updated);
    return { job: updated, active: true };
  }

  // Unfenced, the fake completes whatever state the job is in (tests drive
  // created jobs straight to completed). Fenced, it mirrors the real broker:
  // only the held active attempt completes, plus the J61 salvage of that
  // attempt's own un-reclaimed retry; anything else is a no-op.
  async complete(id: string, output: unknown, fence: JobAttemptFence = {}): Promise<JobView> {
    const job = this.getExisting(id);
    if (
      fence.attempt !== undefined &&
      !holdsAttempt(job, fence) &&
      // The lapsed attempt's own, un-reclaimed retry (one bump past it here).
      !(job.state === "retry" && job.retryCount === fence.attempt + 1)
    ) {
      return job;
    }
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

  async fail(id: string, error: JobError, fence: JobAttemptFence = {}): Promise<JobView> {
    const job = this.getExisting(id);
    // Mirrors pg-boss's failJobsById SQL (`WHERE state < 'completed'`): failing a
    // job that already reached a terminal state is a no-op, not an overwrite.
    // This matters for #161's side-effect replay: completion is persisted before
    // the side-effect fan-out, so when the watcher exhausts its complete() retries
    // on side_effects_failed and falls back to fail(), the completed row (and its
    // paid-for output) must survive untouched. Fenced, only the held attempt fails.
    if (TERMINAL_JOB_STATES.has(job.state) || (fence.attempt !== undefined && !holdsAttempt(job, fence))) {
      return job;
    }
    const now = new Date().toISOString();

    // Unlike pg-boss (which bumps retryCount at the NEXT claim), the fake bumps
    // it here, on the failure. The attempt a claimant holds still differs from
    // any later claim's, so the J60 fence behaves the same; only the J61
    // salvage check (complete()) has to account for the earlier bump.
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

  // Straight to terminal `failed`, skipping remaining retries (#288d): retryCount
  // is preserved (only the state and error/failedAt change), mirroring the real
  // broker's retry_limit=0 + fail path. A no-op on an already-terminal job, like
  // fail() — protecting the completion-replay contract.
  async failTerminal(id: string, error: JobError, fence: JobAttemptFence = {}): Promise<JobView> {
    const job = this.getExisting(id);
    if (TERMINAL_JOB_STATES.has(job.state) || (fence.attempt !== undefined && !holdsAttempt(job, fence))) {
      return job;
    }
    const now = new Date().toISOString();
    const failed: JobView = {
      ...job,
      state: "failed",
      error,
      failedAt: now,
      updatedAt: now
    };
    this.jobs.set(id, failed);
    return failed;
  }

  async cancel(id: string): Promise<JobView> {
    const job = this.getExisting(id);
    // Mirrors pg-boss's cancelJobs SQL (`WHERE state < 'completed'`): cancelling a
    // job that has already reached a terminal state is a no-op, not an overwrite.
    // This matters for any cancel that races a completion (#162): a job that
    // completes/fails just before the cancel call reaches the broker must keep
    // its real terminal state, not flip to "cancelled".
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
    // A retried job's next terminal failure settles afresh (J65).
    this.settlements.delete(id);
    return retried;
  }

  // Single-process mirror of the real ledger (J64): a settled id, or one being
  // settled right now, is skipped; a run that throws leaves it unsettled.
  async settleFailure(job: JobView, run: () => Promise<void>): Promise<boolean> {
    if (this.settlements.has(job.id)) return false;
    this.settlements.set(job.id, "claimed");
    try {
      await run();
    } catch (error) {
      this.settlements.delete(job.id);
      throw error;
    }
    this.settlements.set(job.id, "settled");
    return true;
  }

  // The fake has no settlement epoch: every failed job it holds is eligible.
  async listUnsettledFailures(limit: number): Promise<JobView[]> {
    return [...this.jobs.values()]
      .filter((job) => job.state === "failed" && !job.deadLetter && !this.settlements.has(job.id))
      .sort((a, b) => (a.failedAt ?? "").localeCompare(b.failedAt ?? ""))
      .slice(0, limit);
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

  // Mirrors the real broker's SQL: every job of the type (the fake never
  // dead-letters, so all its jobs sit on work queues), optionally only in-flight
  // ones, optionally only those whose input carries each listed field verbatim,
  // newest first and unpaged.
  async findMatchingJobs(match: JobMatch): Promise<JobView[]> {
    const wanted = Object.entries(match.input ?? {});
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.type === match.type &&
          !job.deadLetter &&
          (!match.inFlight || IN_FLIGHT_JOB_STATES.has(job.state)) &&
          wanted.every(([field, value]) => inputField(job.input, field) === value)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async countInFlight(types: JobType[], servedCapabilities?: readonly JobCapability[]): Promise<number> {
    return this.countInFlightSync(types, servedCapabilities);
  }

  // Shared by countInFlight and createIfAdmitted so both apply the identical
  // in-flight predicate — they must never disagree on what counts. An active job
  // always counts; a queued one only on a queue a live watcher serves, when the
  // served set is given (RL29).
  private countInFlightSync(types: JobType[], servedCapabilities?: readonly JobCapability[]): number {
    const wanted = new Set(types);
    const servedQueues = servedCapabilities ? new Set(queueNamesForCapabilities(servedCapabilities)) : undefined;
    let count = 0;
    for (const job of this.jobs.values()) {
      if (!wanted.has(job.type) || !IN_FLIGHT_JOB_STATES.has(job.state)) continue;
      if (job.state !== "active" && servedQueues && !servedQueues.has(job.queueName)) continue;
      count += 1;
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
      throw new JobNotFoundError(id);
    }
    return job;
  }
}

// Whether `fence` (unfenced: any claimant) still holds `job`: it is active, at
// the fenced attempt when one is given — pg-boss's attemptFence.
function holdsAttempt(job: JobView, fence: JobAttemptFence): boolean {
  return job.state === "active" && (fence.attempt === undefined || job.retryCount === fence.attempt);
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
