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
  // Timezone applied to scheduled (cron) jobs. Defaults to UTC.
  scheduleTimezone?: string;
}

export type PgBossQueuePolicyOverrides = Partial<Pick<
  UpdateQueueOptions,
  "retryLimit" | "retryDelay" | "retryBackoff" | "retryDelayMax"
>>;

const queueDefinitions = allQueueDefinitions();
const queueByName = new Map(queueDefinitions.map((queue) => [queue.name, queue]));
const workQueues = queueDefinitions.filter((queue) => !queue.deadLetter);

// A JobType fans out to one queue per AI provider (plus each queue's dead-letter
// queue) for provider-routed job types, or a single work/dead-letter pair
// otherwise — see packages/jobs/src/catalog.ts. Pre-grouping here lets list()
// scan only the queues that can possibly hold a given type instead of every
// queue pg-boss knows about.
const queuesByType = new Map<JobType, QueueDefinition[]>();
for (const queue of queueDefinitions) {
  const existing = queuesByType.get(queue.type);
  if (existing) existing.push(queue);
  else queuesByType.set(queue.type, [queue]);
}

// Bounds how many queues locate() probes concurrently for a single job id, so a
// get()/mutate() call cannot open one connection per queue (128+ in this catalog)
// against pg-boss's pool all at once.
const LOCATE_CONCURRENCY = 8;

// The queues a given job type can land in: its work queue(s) plus their
// dead-letter queues. Exported standalone (pure, no pg-boss instance needed) so
// the scoping logic list() relies on is unit-testable without a database.
export function queueDefinitionsForType(type: JobType): QueueDefinition[] {
  return queuesByType.get(type) ?? [];
}

// pg-boss's own job states that mean "not yet finished" — a job counted here is
// occupying capacity right now (queued, awaiting retry, or executing).
const IN_FLIGHT_STATES = ["created", "retry", "active"] as const;

// pg-boss's default schema when ConstructorOptions.schema is unset. countInFlight
// queries the job table directly (pg-boss's public API has no count), so it needs
// the schema name; guarded by SCHEMA_IDENTIFIER since it is interpolated into SQL.
const DEFAULT_PGBOSS_SCHEMA = "pgboss";
const SCHEMA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class PgBossJobBroker implements JobBroker {
  private readonly boss: PgBoss;
  private readonly schema: string;
  private readonly queuePolicyOverrides: PgBossQueuePolicyOverrides;
  private readonly scheduleTimezone: string;
  private claimCursor = 0;
  private started = false;

  constructor(options: PgBossJobBrokerOptions) {
    const schema = options.schema ?? DEFAULT_PGBOSS_SCHEMA;
    if (!SCHEMA_IDENTIFIER.test(schema)) {
      throw new Error(`Invalid pg-boss schema name: "${schema}"`);
    }
    this.schema = schema;
    const bossOptions: ConstructorOptions = {
      connectionString: options.connectionString,
      schema: options.schema,
      persistWarnings: true,
      supervise: true,
      schedule: true
    };
    this.boss = new PgBoss(bossOptions);
    this.queuePolicyOverrides = options.queuePolicyOverrides ?? {};
    this.scheduleTimezone = options.scheduleTimezone ?? "UTC";
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
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.boss.stop();
  }

  isStarted(): boolean {
    return this.started;
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

  // pg-boss 12's findJobs(name, options) has no limit/offset/orderBy and no
  // state or createdAt filter — it always returns every row in the named queue's
  // table (see node_modules/pg-boss/dist/plans.js#findJobs). The one lever we do
  // have is *which queues* get scanned: when the caller filters by job type, we
  // only need the (small, fixed) set of queues that type can ever land in —
  // queuesByType, built from the catalog's provider fan-out — instead of every
  // queue pg-boss knows about (128 in this catalog at the time of writing).
  // Without a type filter we still have to scan every queue; that case is
  // unavoidable with the public API and is unchanged from before.
  //
  // Because state/createdAfter/pagination still happen in JS after the fetch,
  // `total` reflects an exact count of the rows in the scanned queues after
  // filtering — it is not an approximation, but it does mean a query that scans
  // many queues without a type filter still loads every job in them to compute
  // it. There's no count-only pg-boss API that accepts our state/createdAfter
  // filters to avoid that.
  async list(filters: JobListFilters): Promise<{ jobs: JobView[]; total: number }> {
    const queuesToScan = filters.type ? queueDefinitionsForType(filters.type) : queueDefinitions;
    const batches = await Promise.all(queuesToScan.map(async (queue) => {
      const jobs = await this.boss.findJobs<JobEnvelope>(queue.name);
      return jobs.map((job) => toJobView(queue.name, job));
    }));
    let jobs = batches.flat();
    if (filters.state) jobs = jobs.filter((job) => job.state === filters.state);
    if (filters.createdAfter) jobs = jobs.filter((job) => job.createdAt > filters.createdAfter!);

    jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const total = jobs.length;
    const offset = Math.max(0, filters.offset ?? 0);
    const limit = Math.min(200, Math.max(1, filters.limit ?? 200));
    return { jobs: jobs.slice(offset, offset + limit), total };
  }

  // One aggregate COUNT over the (partitioned) job table, scoped to the work
  // queues the given types fan out to and to the in-flight states. This is
  // deliberately not built on list()/findJobs: that loads every row in each
  // scanned queue to count in JS, which is far too expensive for a per-request
  // admission check. pg-boss exposes no count API that takes our filters, so we
  // query its table directly via getDb() — the name predicate prunes to the
  // relevant partitions. Dead-letter queues are excluded (a dead-lettered job is
  // finished work, not in flight).
  async countInFlight(types: JobType[]): Promise<number> {
    const queueNames = types
      .flatMap((type) => queueDefinitionsForType(type))
      .filter((queue) => !queue.deadLetter)
      .map((queue) => queue.name);
    if (queueNames.length === 0) {
      return 0;
    }
    const result = await this.boss.getDb().executeSql(
      `SELECT count(*)::int AS count
         FROM "${this.schema}".job
        WHERE name = ANY($1) AND state = ANY($2)`,
      [queueNames, [...IN_FLIGHT_STATES]]
    );
    return Number(result.rows[0]?.count ?? 0);
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
        { key: schedule.storageKey, tz: this.scheduleTimezone }
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

  // The post-operation requireJob() fetch here is a second round trip, but it is
  // not a redundant queue *scan* — it already knows located.queue.name, so it is
  // a single scoped lookup, not another locate() loop. It can't be replaced with
  // located.job (the pre-operation row): every current operation (touch/
  // complete/fail/cancel) changes a field mutate()'s callers depend on
  // (heartbeatAt, state, output, error, completedAt/cancelledAt/failedAt,
  // retryCount) and pg-boss's complete/fail/cancel/touch calls return no row data
  // to apply those changes from (CommandResponse is empty), so returning stale
  // pre-operation state would be wrong. Only locate()'s queue *scan* is the part
  // this change bounds (see locate() below); the scoped refetch stays.
  private async mutate(id: string, operation: (queueName: string) => Promise<unknown>): Promise<JobView> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Job not found: ${id}`);
    await operation(located.queue.name);
    return this.requireJob(located.queue.name, id);
  }

  // pg-boss has no global "find job by id across all queues" call — every read is
  // scoped to one queue name (see node_modules/pg-boss/dist/manager.js#findJobs /
  // #getJobById), and a job id alone doesn't tell us which of this catalog's 128
  // queues holds it. We still have to probe queues, but probing them
  // LOCATE_CONCURRENCY-at-a-time instead of one sequential round trip per queue
  // turns up to 128 serial awaits into a small number of parallel batches.
  private async locate(id: string): Promise<{ queue: QueueDefinition; job: JobWithMetadata<JobEnvelope> } | undefined> {
    for (let start = 0; start < queueDefinitions.length; start += LOCATE_CONCURRENCY) {
      const batch = queueDefinitions.slice(start, start + LOCATE_CONCURRENCY);
      const results = await Promise.all(batch.map(async (queue) => {
        const [job] = await this.boss.findJobs<JobEnvelope>(queue.name, { id });
        return job ? { queue, job } : undefined;
      }));
      const found = results.find((result) => result !== undefined);
      if (found) return found;
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
