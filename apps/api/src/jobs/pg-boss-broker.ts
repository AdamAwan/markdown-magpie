import {
  allQueueDefinitions,
  jobDefinition,
  queueNameForJob,
  queueNamesForCapabilities,
  type JobError,
  type JobState,
  type JobType,
  type JobView,
  type QueueDefinition
} from "@magpie/jobs";
import { CronExpressionParser } from "cron-parser";
import { PgBoss, type ConstructorOptions, type JobWithMetadata, type UpdateQueueOptions } from "pg-boss";
import type { DesiredSchedule, JobBroker, JobListFilters, ScheduleView } from "./broker.js";
import { logger } from "../logger.js";

interface JobEnvelope {
  type: JobType;
  input: unknown;
}

export interface PgBossJobBrokerOptions {
  connectionString: string;
  schema?: string;
  queuePolicyOverrides?: PgBossQueuePolicyOverrides;
}

export type PgBossQueuePolicyOverrides = Partial<Pick<
  UpdateQueueOptions,
  "retryLimit" | "retryDelay" | "retryBackoff" | "retryDelayMax"
>>;

const queueDefinitions = allQueueDefinitions();
const queueByName = new Map(queueDefinitions.map((queue) => [queue.name, queue]));
const workQueues = queueDefinitions.filter((queue) => !queue.deadLetter);

export class PgBossJobBroker implements JobBroker {
  private readonly boss: PgBoss;
  private readonly queuePolicyOverrides: PgBossQueuePolicyOverrides;
  private claimCursor = 0;

  constructor(options: PgBossJobBrokerOptions) {
    const bossOptions: ConstructorOptions = {
      connectionString: options.connectionString,
      schema: options.schema,
      persistWarnings: true,
      supervise: true,
      schedule: true
    };
    this.boss = new PgBoss(bossOptions);
    this.queuePolicyOverrides = options.queuePolicyOverrides ?? {};
    this.boss.on("error", (error) => logger.error({ err: error.message }, "pg-boss error"));
    this.boss.on("warning", (warning) => logger.warn({ err: warning.message }, "pg-boss warning"));
  }

  async start(): Promise<void> {
    await this.boss.start();

    for (const queue of queueDefinitions.filter((definition) => definition.deadLetter)) {
      await this.boss.createQueue(queue.name);
    }
    for (const queue of workQueues) {
      const policy = queue.policy!;
      const options = pgBossQueueOptions(policy, this.queuePolicyOverrides);
      await this.boss.createQueue(queue.name, options);
      await this.boss.updateQueue(queue.name, options);
    }
  }

  async stop(): Promise<void> {
    await this.boss.stop();
  }

  async create(type: JobType, input: unknown): Promise<JobView> {
    const definition = jobDefinition(type);
    const parsed = definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`Invalid input for job type "${type}": ${parsed.error.message}`);
    }

    const queueName = queueNameForJob(type, parsed.data);
    const id = await this.boss.send(queueName, { type, input: parsed.data } satisfies JobEnvelope);
    if (!id) {
      throw new Error(`pg-boss did not create job type "${type}"`);
    }
    return this.requireJob(queueName, id);
  }

  async claim(workerName: string, capabilities: Parameters<JobBroker["claim"]>[1]): Promise<JobView | undefined> {
    void workerName;
    const queues = queueNamesForCapabilities(capabilities);
    if (queues.length === 0) return undefined;

    const start = this.claimCursor % queues.length;
    for (let offset = 0; offset < queues.length; offset += 1) {
      const index = (start + offset) % queues.length;
      const queueName = queues[index]!;
      const [job] = await this.boss.fetch<JobEnvelope>(queueName, {
        batchSize: 1,
        includeMetadata: true,
        orderByCreatedOn: true
      });
      if (job) {
        this.claimCursor = (index + 1) % queues.length;
        return toJobView(queueName, job);
      }
    }

    this.claimCursor = (start + 1) % queues.length;
    return undefined;
  }

  async heartbeat(id: string): Promise<JobView> {
    return this.mutate(id, (queueName) => this.boss.touch(queueName, id));
  }

  async complete(id: string, output: unknown): Promise<JobView> {
    return this.mutate(id, (queueName) => this.boss.complete(queueName, id, asRecord(output)));
  }

  async fail(id: string, error: JobError): Promise<JobView> {
    return this.mutate(id, (queueName) => this.boss.fail(queueName, id, error));
  }

  async cancel(id: string): Promise<JobView> {
    return this.mutate(id, (queueName) => this.boss.cancel(queueName, id));
  }

  async retry(id: string): Promise<JobView> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Job not found: ${id}`);
    if (toJobView(located.queue.name, located.job).state !== "failed") {
      throw new Error(`Cannot retry job ${id}; only failed jobs can be retried`);
    }
    await this.boss.retry(located.queue.name, id);
    return this.requireJob(located.queue.name, id);
  }

  async get(id: string): Promise<JobView | undefined> {
    const located = await this.locate(id);
    return located ? toJobView(located.queue.name, located.job) : undefined;
  }

  async list(filters: JobListFilters): Promise<{ jobs: JobView[]; total: number }> {
    const batches = await Promise.all(queueDefinitions.map(async (queue) => {
      const jobs = await this.boss.findJobs<JobEnvelope>(queue.name);
      return jobs.map((job) => toJobView(queue.name, job));
    }));
    let jobs = batches.flat();
    if (filters.type) jobs = jobs.filter((job) => job.type === filters.type);
    if (filters.state) jobs = jobs.filter((job) => job.state === filters.state);
    if (filters.createdAfter) jobs = jobs.filter((job) => job.createdAt > filters.createdAfter!);

    jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const total = jobs.length;
    const offset = Math.max(0, filters.offset ?? 0);
    const limit = Math.min(200, Math.max(1, filters.limit ?? 200));
    return { jobs: jobs.slice(offset, offset + limit), total };
  }

  async reconcileSchedules(desired: DesiredSchedule[]): Promise<void> {
    const normalized = desired.map((schedule) => {
      const definition = jobDefinition(schedule.type);
      const parsed = definition.inputSchema.safeParse(schedule.input);
      if (!parsed.success) {
        throw new Error(`Invalid schedule input for job type "${schedule.type}": ${parsed.error.message}`);
      }
      return {
        ...schedule,
        input: parsed.data,
        queueName: queueNameForJob(schedule.type, parsed.data),
        storageKey: storageScheduleKey(schedule.key)
      };
    });
    const desiredSchedules = new Set(normalized
      .filter((schedule) => schedule.enabled)
      .map((schedule) => scheduleIdentity(schedule.queueName, schedule.storageKey)));
    const existing = await this.boss.getSchedules();
    for (const schedule of existing) {
      if (isJobEnvelope(schedule.data)
        && !desiredSchedules.has(scheduleIdentity(schedule.name, schedule.key))) {
        await this.boss.unschedule(schedule.name, schedule.key);
      }
    }

    for (const schedule of normalized) {
      if (!schedule.enabled) {
        await this.boss.unschedule(schedule.queueName, schedule.storageKey);
        continue;
      }
      await this.boss.schedule(
        schedule.queueName,
        schedule.cron,
        { type: schedule.type, input: schedule.input } satisfies JobEnvelope,
        { key: schedule.storageKey, tz: process.env.JOB_SCHEDULE_TIMEZONE ?? "UTC" }
      );
    }
  }

  async listSchedules(): Promise<ScheduleView[]> {
    const schedules = await this.boss.getSchedules();
    return schedules.flatMap((schedule) => isJobEnvelope(schedule.data) ? [{
      key: publicScheduleKey(schedule.key),
      type: schedule.data.type,
      cron: schedule.cron,
      enabled: true,
      // pg-boss does not surface a portable next-run timestamp, so derive it from
      // the cron in the same timezone the schedule fires in.
      nextRunAt: nextRunFor(schedule.cron, schedule.timezone)
    }] : []);
  }

  async reset(): Promise<void> {
    for (const schedule of await this.boss.getSchedules()) {
      if (isJobEnvelope(schedule.data)) await this.boss.unschedule(schedule.name, schedule.key);
    }
    await this.boss.deleteAllJobs();
  }

  private async mutate(id: string, operation: (queueName: string) => Promise<unknown>): Promise<JobView> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Job not found: ${id}`);
    await operation(located.queue.name);
    return this.requireJob(located.queue.name, id);
  }

  private async locate(id: string): Promise<{ queue: QueueDefinition; job: JobWithMetadata<JobEnvelope> } | undefined> {
    for (const queue of queueDefinitions) {
      const [job] = await this.boss.findJobs<JobEnvelope>(queue.name, { id });
      if (job) return { queue, job };
    }
    return undefined;
  }

  private async requireJob(queueName: string, id: string): Promise<JobView> {
    const [job] = await this.boss.findJobs<JobEnvelope>(queueName, { id });
    if (!job) throw new Error(`Job not found after pg-boss operation: ${id}`);
    return toJobView(queueName, job);
  }
}

export function pgBossQueueOptions(
  policy: Readonly<NonNullable<QueueDefinition["policy"]>>,
  overrides: PgBossQueuePolicyOverrides = {}
): UpdateQueueOptions {
  const options: UpdateQueueOptions = {
    retryLimit: policy.retryLimit,
    retryDelay: policy.retryDelay,
    retryBackoff: policy.retryBackoff,
    retryDelayMax: policy.retryDelayMax,
    heartbeatSeconds: policy.heartbeatSeconds,
    expireInSeconds: policy.expireInSeconds,
    retentionSeconds: policy.retentionSeconds,
    deleteAfterSeconds: policy.deleteAfterSeconds,
    deadLetter: policy.deadLetter,
    ...overrides
  };
  if (options.retryBackoff === false) {
    delete options.retryDelayMax;
  }
  return options;
}

function toJobView(queueName: string, job: JobWithMetadata<JobEnvelope>): JobView {
  const queue = queueByName.get(queueName);
  if (!queue) throw new Error(`Unknown pg-boss queue: ${queueName}`);
  if (!isJobEnvelope(job.data)) throw new Error(`Invalid job envelope for ${job.id}`);

  const state: JobState = job.blocked && (job.state === "created" || job.state === "retry")
    ? "blocked"
    : job.state;
  const output = isRecord(job.output) ? job.output : undefined;
  const error = (state === "retry" || state === "failed") && isJobError(output) ? output : undefined;
  const updatedAt = latestDate(job.createdOn, job.startedOn, job.heartbeatOn, job.completedOn).toISOString();

  return {
    id: job.id,
    type: job.data.type,
    queueName,
    deadLetter: queue.deadLetter,
    state,
    input: job.data.input,
    output: state === "completed" ? output : undefined,
    error,
    retryCount: job.retryCount,
    retryLimit: job.retryLimit,
    createdAt: job.createdOn.toISOString(),
    updatedAt,
    startedAt: dateString(job.startedOn),
    completedAt: state === "completed" ? dateString(job.completedOn) : undefined,
    cancelledAt: state === "cancelled" ? dateString(job.completedOn) : undefined,
    failedAt: state === "failed" ? dateString(job.completedOn) : undefined,
    retryAt: state === "retry" ? dateString(job.startAfter) : undefined,
    heartbeatAt: dateString(job.heartbeatOn),
    heartbeatSeconds: job.heartbeatSeconds ?? undefined,
    expireInSeconds: job.expireInSeconds
  };
}

function isJobEnvelope(value: unknown): value is JobEnvelope {
  return isRecord(value)
    && typeof value.type === "string"
    && "input" in value
    && queueDefinitions.some((queue) => queue.type === value.type);
}

function isJobError(value: unknown): value is JobError {
  return isRecord(value)
    && typeof value.code === "string"
    && typeof value.message === "string"
    && typeof value.category === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Job output must be an object");
  return value;
}

function dateString(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

function latestDate(...values: Array<Date | null | undefined>): Date {
  return new Date(Math.max(...values.filter((value): value is Date => value instanceof Date).map((value) => value.getTime())));
}

// The next fire time for a cron in the schedule's timezone, as an ISO string, or
// undefined when the expression cannot be parsed.
function nextRunFor(cron: string, timezone: string): string | undefined {
  try {
    return CronExpressionParser.parse(cron, { tz: timezone }).next().toISOString() ?? undefined;
  } catch {
    return undefined;
  }
}

const SCHEDULE_KEY_PREFIX = "magpie_";

function storageScheduleKey(key: string): string {
  return `${SCHEDULE_KEY_PREFIX}${Buffer.from(key, "utf8").toString("base64url")}`;
}

function publicScheduleKey(key: string): string {
  if (!key.startsWith(SCHEDULE_KEY_PREFIX)) return key;
  return Buffer.from(key.slice(SCHEDULE_KEY_PREFIX.length), "base64url").toString("utf8");
}

function scheduleIdentity(queueName: string, key: string): string {
  return `${queueName}\0${key}`;
}
