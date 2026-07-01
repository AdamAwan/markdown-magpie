import { randomUUID } from "node:crypto";
import {
  jobDefinition,
  queueNameForJob,
  queueNamesForCapabilities,
  type JobCapability,
  type JobError,
  type JobType,
  type JobView
} from "@magpie/jobs";
import { CronExpressionParser } from "cron-parser";
import type { DesiredSchedule, JobBroker, JobListFilters, ScheduleView } from "./broker.js";

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
      retryCount: 0,
      retryLimit: definition.policy.retryLimit,
      expireInSeconds: definition.policy.expireInSeconds,
      createdAt: now,
      updatedAt: now
    };

    this.jobs.set(job.id, job);
    return job;
  }

  async claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined> {
    const acceptedQueues = new Set(queueNamesForCapabilities(capabilities));

    for (const [id, job] of this.jobs) {
      if ((job.state === "created" || job.state === "retry") && acceptedQueues.has(job.queueName)) {
        const now = new Date().toISOString();
        const claimed: JobView = {
          ...job,
          state: "active",
          startedAt: now,
          updatedAt: now
        };
        this.jobs.set(id, claimed);
        void workerName; // recorded in real implementation; not needed in fake
        return claimed;
      }
    }

    return undefined;
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

// The next fire time for a cron in UTC, as an ISO string, or undefined when the
// expression cannot be parsed. UTC matches the real broker's default timezone.
function nextRunFor(cron: string): string | undefined {
  try {
    return CronExpressionParser.parse(cron, { tz: "UTC" }).next().toISOString() ?? undefined;
  } catch {
    return undefined;
  }
}
