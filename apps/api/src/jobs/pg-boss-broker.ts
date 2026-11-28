import {
  allQueueDefinitions,
  isInteractiveJobType,
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
import { injectTraceContext, type TraceCarrier } from "@magpie/telemetry";
import type pg from "pg";
import { PgBoss, type ConstructorOptions, type JobWithMetadata, type Queue } from "pg-boss";
import type {
  AdmissionResult,
  DesiredSchedule,
  InFlightCapacity,
  JobBroker,
  JobListFilters,
  JobMatch,
  ScheduleView
} from "./broker.js";
import { logger } from "../logger.js";

interface JobEnvelope {
  type: JobType;
  input: unknown;
  // The W3C trace context of the request that enqueued this job, when telemetry
  // is enabled. Optional so scheduled fires, a disabled build, and pre-existing
  // jobs all remain valid envelopes. The watcher extracts it to continue the trace.
  traceContext?: TraceCarrier;
}

export interface PgBossJobBrokerOptions {
  connectionString: string;
  // The shared process-wide Postgres pool. createIfAdmitted checks out one
  // dedicated client from it to hold an advisory transaction lock across the
  // count+enqueue critical section (pg-boss's own pooled connection can't be
  // pinned for that). The same schema/database as connectionString.
  pool: pg.Pool;
  schema?: string;
  queuePolicyOverrides?: PgBossQueuePolicyOverrides;
  // Timezone applied to scheduled (cron) jobs. Defaults to UTC.
  scheduleTimezone?: string;
}

// Options accepted by both createQueue and updateQueue. pg-boss's own
// UpdateQueueOptions widens some fields to `null` (to clear them), which
// createQueue does not accept, so the create-side shape is the common one.
type QueueConfig = Omit<Queue, "name">;

export type PgBossQueuePolicyOverrides = Partial<
  Pick<QueueConfig, "retryLimit" | "retryDelay" | "retryBackoff" | "retryDelayMax">
>;

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

// Whether a work queue holds interactive-class jobs (see INTERACTIVE_AI_JOB_TYPES
// in @magpie/jobs) — the claim-side lane split keys off the queue's job type.
function isInteractiveQueue(queueName: string): boolean {
  const queue = queueByName.get(queueName);
  return queue !== undefined && isInteractiveJobType(queue.type);
}

// Every queue this catalog defines, work and dead-letter alike — the scope of an
// untyped list() and of locate()'s by-id lookup.
const ALL_QUEUE_NAMES = queueDefinitions.map((queue) => queue.name);

// pg-boss job ids are Postgres uuids (gen_random_uuid()).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The job-row fields toJobView reads. A subset of pg-boss's JobWithMetadata (so
// fetch()/getJobById() rows satisfy it directly), with the stored jsonb columns
// widened to `unknown` because our own SQL reads them untyped — toJobView
// validates the envelope and narrows the output before using either.
type JobRow = Pick<
  JobWithMetadata<JobEnvelope>,
  | "id"
  | "name"
  | "state"
  | "blocked"
  | "retryCount"
  | "retryLimit"
  | "createdOn"
  | "startedOn"
  | "heartbeatOn"
  | "completedOn"
  | "startAfter"
  | "heartbeatSeconds"
  | "expireInSeconds"
> & { data: unknown; output: unknown };

// The SELECT list producing a JobRow, aliased to pg-boss's own camelCase names
// (plans.js JOB_COLUMNS_ALL) for the columns toJobView reads.
const JOB_ROW_COLUMNS = `id, name, data, state::text AS state, blocked, output,
  retry_count AS "retryCount", retry_limit AS "retryLimit",
  created_on AS "createdOn", started_on AS "startedOn", heartbeat_on AS "heartbeatOn",
  completed_on AS "completedOn", start_after AS "startAfter",
  heartbeat_seconds AS "heartbeatSeconds", expire_seconds AS "expireInSeconds"`;

// The SQL predicate for a list() state filter, appending its parameter. JobView's
// `blocked` is derived (toJobView): a created/retry row pg-boss holds back with
// `blocked = true`. So `blocked` selects those rows, and `created`/`retry` must
// exclude them — otherwise the SQL filter would disagree with the state the
// returned view reports.
function stateCondition(state: JobState, params: unknown[]): string {
  if (state === "blocked") {
    return `state IN ('created', 'retry') AND blocked`;
  }
  params.push(state);
  const condition = `state = $${params.length}`;
  return state === "created" || state === "retry" ? `${condition} AND NOT blocked` : condition;
}

// The queues a given job type can land in: its work queue(s) plus their
// dead-letter queues. Exported standalone (pure, no pg-boss instance needed) so
// the scoping logic list() relies on is unit-testable without a database.
export function queueDefinitionsForType(type: JobType): QueueDefinition[] {
  return queuesByType.get(type) ?? [];
}

// pg-boss's own job states that mean "not yet finished" — a job counted here is
// occupying capacity right now (queued, awaiting retry, or executing).
const IN_FLIGHT_STATES = ["created", "retry", "active"] as const;

// The single advisory-lock key ALL AI admission control shares (#288 a and b).
// createIfAdmitted takes this lock for its count+enqueue critical section, so
// every admission decision — interactive asks (a) and maintenance fan-out (b)
// alike — is serialized against the same key and their global in-flight counts
// stay mutually exclusive cluster-wide. A fixed constant (not derived from the
// capacity) is deliberate: distinct capacities must still contend for the one
// lock, or two concurrent lanes could each admit up to the ceiling. Chosen to
// not collide with the migrator's advisory key (scripts/migrate.mjs).
const AI_ADMISSION_LOCK_KEY = 288_2882_0001n;

// pg-boss's default schema when ConstructorOptions.schema is unset. countInFlight
// queries the job table directly (pg-boss's public API has no count), so it needs
// the schema name; guarded by SCHEMA_IDENTIFIER since it is interpolated into SQL.
export const DEFAULT_PGBOSS_SCHEMA = "pgboss";
export const SCHEMA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class PgBossJobBroker implements JobBroker {
  private readonly boss: PgBoss;
  private readonly pool: pg.Pool;
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
    this.pool = options.pool;
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
    const { queueName, id } = await this.enqueue(type, input);
    return this.requireJob(queueName, id);
  }

  // The single typed enqueue path: validate against the job's input schema, route
  // to the provider/destination-fanned queue, and send with the active trace
  // context. Factored out so create() and createIfAdmitted() cannot drift on
  // validation, queue routing, or trace propagation.
  private async enqueue(type: JobType, input: unknown): Promise<{ queueName: string; id: string }> {
    const definition = jobDefinition(type);
    const parsed = definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`Invalid input for job type "${type}": ${parsed.error.message}`);
    }

    const queueName = queueNameForJob(type, parsed.data);
    // Capture the active trace context (empty when telemetry is disabled) so the
    // watcher can continue the same trace across the queue boundary. Stored only
    // when non-empty to keep envelopes clean in the default build.
    const carrier = injectTraceContext();
    const traceContext = Object.keys(carrier).length > 0 ? carrier : undefined;
    const id = await this.boss.send(queueName, { type, input: parsed.data, traceContext } satisfies JobEnvelope);
    if (!id) {
      throw new Error(`pg-boss did not create job type "${type}"`);
    }
    return { queueName, id };
  }

  // Atomic count+enqueue under a cluster-wide advisory lock — the fix for the
  // admission-control TOCTOU (#288a). A dedicated pool client holds
  // pg_advisory_xact_lock for the whole transaction so no two admissions run
  // their count concurrently: whoever holds the lock counts, decides, and (if
  // admitted) enqueues before the next admission can even count.
  async createIfAdmitted(type: JobType, input: unknown, capacity: InFlightCapacity): Promise<AdmissionResult> {
    const globalNames = this.workQueueNames(capacity.types);
    const reserveNames = capacity.reserve ? this.workQueueNames(capacity.reserve.types) : [];

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize all admissions on one key. This is a transaction-scoped lock:
      // it releases automatically at COMMIT/ROLLBACK, so no explicit unlock path
      // can leak it on an error.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [AI_ADMISSION_LOCK_KEY.toString()]);

      // We rely on READ COMMITTED (Postgres's default) here — do NOT raise this
      // transaction to REPEATABLE READ. Under READ COMMITTED each statement takes
      // a fresh snapshot, so this count (issued after we hold the lock) sees every
      // row pg-boss committed before now, including sends from earlier admissions.
      // REPEATABLE READ would freeze the snapshot at BEGIN and miss them, defeating
      // the whole point. The WHERE already restricts to global queues; the FILTERs
      // split out the global total and the reserve-lane subset in one pass.
      const counts = await client.query<{ global: number; reserve: number }>(
        `SELECT count(*) FILTER (WHERE name = ANY($1))::int AS global,
                count(*) FILTER (WHERE name = ANY($2))::int AS reserve
           FROM "${this.schema}".job
          WHERE state = ANY($3) AND name = ANY($1)`,
        [globalNames, reserveNames, [...IN_FLIGHT_STATES]]
      );
      const inFlight = Number(counts.rows[0]?.global ?? 0);
      const reserveInFlight = Number(counts.rows[0]?.reserve ?? 0);

      // Byte-for-byte the ai-capacity.ts decision: an interactive request is shed
      // only when BOTH its reserved lane is full AND the global ceiling is reached.
      const blocked = capacity.reserve
        ? reserveInFlight >= capacity.reserve.reserved && inFlight >= capacity.limit
        : inFlight >= capacity.limit;
      if (blocked) {
        await client.query("COMMIT"); // release the lock; nothing was enqueued
        return { admitted: false, inFlight, ...(capacity.reserve ? { reserveInFlight } : {}) };
      }

      // boss.send commits the new row on pg-boss's OWN connection before our
      // COMMIT below releases the lock, so the next admission (which must wait for
      // the lock) counts it. That ordering is exactly what makes count+enqueue one
      // indivisible critical section — the row is durable and visible before any
      // competing admission can observe an in-flight count.
      const { queueName, id } = await this.enqueue(type, input);
      const job = await this.requireJob(queueName, id);
      await client.query("COMMIT");
      return { admitted: true, job, inFlight, ...(capacity.reserve ? { reserveInFlight } : {}) };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A rollback failure (e.g. a dead connection) must not mask the original
        // error; release() below still returns the client to the pool.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(workerName: string, capabilities: Parameters<JobBroker["claim"]>[1]): Promise<JobView | undefined> {
    void workerName;
    const queues = queueNamesForCapabilities(capabilities);
    if (queues.length === 0) return undefined;

    // Interactive lane (#240): a live caller is waiting on interactive-class
    // jobs, so their queues are probed before any background queue — a freed-up
    // watcher picks up an answer_question ahead of patrol fan-out that was
    // enqueued earlier. The interactive partition is at most two queues per
    // provider capability and usually empty, so fixed-order probing costs one
    // fetch per queue and needs no fairness cursor of its own.
    const interactive = queues.filter((name) => isInteractiveQueue(name));
    for (const queueName of interactive) {
      const job = await this.fetchOne(queueName);
      if (job) return toJobView(queueName, job);
    }

    // Background queues keep the original round-robin so no single busy queue
    // (e.g. a patrol's verify_document fan-out) starves its siblings.
    const background = queues.filter((name) => !isInteractiveQueue(name));
    if (background.length === 0) return undefined;
    const start = this.claimCursor % background.length;
    for (let offset = 0; offset < background.length; offset += 1) {
      const index = (start + offset) % background.length;
      const queueName = background[index]!;
      const job = await this.fetchOne(queueName);
      if (job) {
        this.claimCursor = (index + 1) % background.length;
        return toJobView(queueName, job);
      }
    }

    this.claimCursor = (start + 1) % background.length;
    return undefined;
  }

  private async fetchOne(queueName: string): Promise<JobWithMetadata<JobEnvelope> | undefined> {
    const [job] = await this.boss.fetch<JobEnvelope>(queueName, {
      batchSize: 1,
      includeMetadata: true,
      orderByCreatedOn: true
    });
    return job;
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

  // Fail straight to terminal `failed` + dead-letter, skipping remaining retries
  // (#288d). Done in two steps under the same locate()/mutate() precedent
  // countInFlight uses for scoped SQL (guarded by SCHEMA_IDENTIFIER in the
  // constructor):
  //   1. Zero this ONE row's retry_limit via our own scoped UPDATE, pruned to the
  //      partition by the name predicate.
  //   2. Call boss.fail — pg-boss's own failJobsBody then evaluates
  //      `retry_count < retry_limit(=0)` as false and routes the job to terminal
  //      `failed` + the dead-letter queue, reusing its state transition verbatim.
  //
  // GOTCHA — do NOT "simplify" step 1 to `boss.updateJob(id, { retryLimit: 0 })`.
  // pg-boss self-guards updateJob to jobs that are NOT yet active, so it is a
  // silent no-op on the active row a completing job is in, and the job would then
  // retry instead of terminal-failing. The raw UPDATE here is OUR sql, unguarded,
  // so it legally updates the active row. boss.fail no-ops on an already-terminal
  // row (its `state < 'completed'` guard), so failTerminal is a safe no-op there
  // too — protecting the completion-replay contract.
  async failTerminal(id: string, error: JobError): Promise<JobView> {
    return this.mutate(id, async (queueName) => {
      await this.boss
        .getDb()
        .executeSql(`UPDATE "${this.schema}".job SET retry_limit = 0 WHERE name = $1 AND id = $2`, [queueName, id]);
      await this.boss.fail(queueName, id, error);
    });
  }

  // Give an active job back to its queue without spending a retry (J53). pg-boss
  // has no public "un-claim", so this is our own scoped UPDATE (the failTerminal
  // precedent above). The retry accounting it relies on lives in pg-boss's
  // fetchNextJob: a claim increments retry_count only when `started_on IS NOT
  // NULL`, i.e. when the job ran before. Clearing started_on therefore makes the
  // next claim count exactly as this released one did — retry_count, retry_limit
  // and the backoff schedule are untouched. The state goes back to what a fetch
  // would have found (`retry` once the job has failed before, else `created`),
  // start_after moves up to now so it is claimable immediately, and keep_until
  // moves by the same amount (pg-boss's own convention whenever start_after moves,
  // so the retention sweep measures from the new start). `state = 'active'`
  // makes it a no-op on a job a cancel, completion or expiry sweep already
  // settled. The schema name is guarded by SCHEMA_IDENTIFIER in the constructor.
  async release(id: string): Promise<JobView> {
    return this.mutate(id, async (queueName) => {
      await this.boss.getDb().executeSql(
        `UPDATE "${this.schema}".job
            SET state = (CASE WHEN retry_count > 0 THEN 'retry' ELSE 'created' END)::"${this.schema}".job_state,
                started_on = NULL,
                heartbeat_on = NULL,
                keep_until = GREATEST(start_after, "${this.schema}".job_now()) + (keep_until - start_after),
                start_after = GREATEST(start_after, "${this.schema}".job_now())
          WHERE name = $1 AND id = $2 AND state = 'active'`,
        [queueName, id]
      );
    });
  }

  async cancel(id: string): Promise<JobView> {
    return this.mutate(id, (queueName) => this.boss.cancel(queueName, id));
  }

  async retry(id: string): Promise<JobView> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Job not found: ${id}`);
    if (located.state !== "failed") {
      throw new Error(`Cannot retry job ${id}; only failed jobs can be retried`);
    }
    await this.boss.retry(located.queueName, id);
    return this.requireJob(located.queueName, id);
  }

  async get(id: string): Promise<JobView | undefined> {
    return this.locate(id);
  }

  // Direct SQL over pg-boss's job table, NOT boss.findJobs. pg-boss 12's public
  // findJobs(name) is a list read capped at LIMIT 1000 by default
  // (LIST_LIMIT_DEFAULT in node_modules/pg-boss/dist/attorney.js) and ordered
  // `created_on ASC` (plans.js#findJobs): once a queue retained more than 1000
  // rows (completed jobs are kept for 30 days — packages/jobs/src/catalog.ts) a
  // findJobs-based listing only ever saw the OLDEST 1000 jobs, so the console
  // showed stale jobs and every in-flight guard built on it went blind.
  //
  // So the whole read happens in Postgres: the type → queue-name set, the state
  // and createdAfter filters, newest-first ordering, LIMIT/OFFSET, and an exact
  // COUNT for `total`. In pg-boss 12 every job, whatever its state, lives in the
  // one `job` table (partitioned by queue name; there is no archive table — the
  // retention sweep deletes rows outright), so this sees every retained job. The
  // `name = ANY(...)` predicate keeps the scan to this catalog's queues and lets
  // job_i15 (name, created_on) serve the ordering.
  async list(filters: JobListFilters): Promise<{ jobs: JobView[]; total: number }> {
    const queueNames = (filters.type ? queueDefinitionsForType(filters.type) : queueDefinitions).map(
      (queue) => queue.name
    );
    const params: unknown[] = [queueNames];
    const conditions = ["name = ANY($1)"];
    if (filters.state) {
      conditions.push(stateCondition(filters.state, params));
    }
    if (filters.createdAfter) {
      params.push(filters.createdAfter);
      conditions.push(`created_on > $${params.length}::timestamptz`);
    }
    const where = conditions.join(" AND ");
    const offset = Math.max(0, filters.offset ?? 0);
    const limit = Math.min(200, Math.max(1, filters.limit ?? 200));
    const [page, count] = await Promise.all([
      this.pool.query<JobRow>(
        `SELECT ${JOB_ROW_COLUMNS}
           FROM "${this.schema}".job
          WHERE ${where}
          ORDER BY created_on DESC, id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      this.pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM "${this.schema}".job WHERE ${where}`,
        params
      )
    ]);
    return {
      jobs: page.rows.map((row) => toJobView(row.name, row)),
      total: Number(count.rows[0]?.total ?? 0)
    };
  }

  // The dedupe/overlap-guard read (see JobMatch): the type's work queues only,
  // the in-flight states and the input containment pushed into SQL, and every
  // match returned unpaged — a guard asking "is a publish for proposal P already
  // queued?" must see that job however many finished publishes are retained.
  // `data @> {"input": {...}}` matches the envelope enqueue() stored.
  async findMatchingJobs(match: JobMatch): Promise<JobView[]> {
    const params: unknown[] = [this.workQueueNames([match.type])];
    const conditions = ["name = ANY($1)"];
    if (match.inFlight) {
      params.push([...IN_FLIGHT_STATES]);
      conditions.push(`state = ANY($${params.length})`);
    }
    if (match.input && Object.keys(match.input).length > 0) {
      params.push(JSON.stringify({ input: match.input }));
      conditions.push(`data @> $${params.length}::jsonb`);
    }
    const result = await this.pool.query<JobRow>(
      `SELECT ${JOB_ROW_COLUMNS}
         FROM "${this.schema}".job
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_on DESC, id DESC`,
      params
    );
    return result.rows.map((row) => toJobView(row.name, row));
  }

  // One aggregate COUNT over the (partitioned) job table, scoped to the work
  // queues the given types fan out to and to the in-flight states — a bare count
  // with no rows materialised, cheap enough for a per-request admission check.
  // pg-boss exposes no count API that takes our filters, so we
  // query its table directly via getDb() — the name predicate prunes to the
  // relevant partitions. Dead-letter queues are excluded (a dead-lettered job is
  // finished work, not in flight).
  async countInFlight(types: JobType[]): Promise<number> {
    const queueNames = this.workQueueNames(types);
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

  // The work queues the given job types fan out to (provider/destination fan-out
  // per the catalog), excluding dead-letter queues (a dead-lettered job is
  // finished work, not in flight, and not a second job). Shared by countInFlight
  // (the cheap pre-check), createIfAdmitted (the atomic count) and
  // findMatchingJobs (the dedupe guards), so all scope to the exact same
  // partitions — they must never disagree on which queues count.
  private workQueueNames(types: JobType[]): string[] {
    return types
      .flatMap((type) => queueDefinitionsForType(type))
      .filter((queue) => !queue.deadLetter)
      .map((queue) => queue.name);
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
    const desiredSchedules = new Set(
      normalized
        .filter((schedule) => schedule.enabled)
        .map((schedule) => scheduleIdentity(schedule.queueName, schedule.storageKey))
    );
    const existing = await this.boss.getSchedules();
    for (const schedule of existing) {
      if (isJobEnvelope(schedule.data) && !desiredSchedules.has(scheduleIdentity(schedule.name, schedule.key))) {
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
    return schedules.flatMap((schedule) =>
      isJobEnvelope(schedule.data)
        ? [
            {
              key: publicScheduleKey(schedule.key),
              type: schedule.data.type,
              cron: schedule.cron,
              enabled: true,
              // pg-boss does not surface a portable next-run timestamp, so derive it from
              // the cron in the same timezone the schedule fires in.
              nextRunAt: nextRunFor(schedule.cron, schedule.timezone)
            }
          ]
        : []
    );
  }

  async reset(): Promise<void> {
    for (const schedule of await this.boss.getSchedules()) {
      if (isJobEnvelope(schedule.data)) await this.boss.unschedule(schedule.name, schedule.key);
    }
    await this.boss.deleteAllJobs();
  }

  // The post-operation requireJob() fetch is a second round trip, a single
  // primary-key lookup on the queue locate() already resolved. It can't be
  // replaced with the pre-operation row: every current operation (touch/
  // complete/fail/cancel) changes a field mutate()'s callers depend on
  // (heartbeatAt, state, output, error, completedAt/cancelledAt/failedAt,
  // retryCount) and pg-boss's complete/fail/cancel/touch calls return no row data
  // to apply those changes from (CommandResponse is empty), so returning stale
  // pre-operation state would be wrong.
  private async mutate(id: string, operation: (queueName: string) => Promise<unknown>): Promise<JobView> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Job not found: ${id}`);
    await operation(located.queueName);
    return this.requireJob(located.queueName, id);
  }

  // Find a job by id alone. pg-boss's own reads are all scoped to one queue name
  // (manager.js#findJobs / #getJobById) and an id doesn't say which of this
  // catalog's queues holds it, so this used to probe every queue in turn — up to
  // one query per queue on every get()/heartbeat/complete, and waitForJob polls
  // get() every 250 ms. Instead it is ONE query over the job table. The
  // `name = ANY(<catalog queues>)` predicate is load-bearing, not just scoping:
  // the table's primary key is (name, id), and pinning name lets Postgres probe
  // that index per queue name rather than scan every retained row for the id.
  // A non-uuid id can't name a pg-boss job (the column is uuid), so it is "not
  // found" rather than a Postgres cast error — matching the in-memory broker.
  private async locate(id: string): Promise<JobView | undefined> {
    if (!UUID_PATTERN.test(id)) return undefined;
    const result = await this.pool.query<JobRow>(
      `SELECT ${JOB_ROW_COLUMNS}
         FROM "${this.schema}".job
        WHERE name = ANY($1) AND id = $2`,
      [ALL_QUEUE_NAMES, id]
    );
    const row = result.rows[0];
    return row ? toJobView(row.name, row) : undefined;
  }

  // Deliberately on pg-boss's own connection (getJobById), not this.pool:
  // createIfAdmitted calls this while holding one pool client inside its
  // advisory-lock transaction, and taking a second client from the same pool
  // there could deadlock against admissions queued on that lock.
  private async requireJob(queueName: string, id: string): Promise<JobView> {
    const job = await this.boss.getJobById<JobEnvelope>(queueName, id);
    if (!job) throw new Error(`Job not found after pg-boss operation: ${id}`);
    return toJobView(queueName, job);
  }
}

export function pgBossQueueOptions(
  policy: Readonly<NonNullable<QueueDefinition["policy"]>>,
  overrides: PgBossQueuePolicyOverrides = {}
): QueueConfig {
  const options: QueueConfig = {
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

function toJobView(queueName: string, job: JobRow): JobView {
  const queue = queueByName.get(queueName);
  if (!queue) throw new Error(`Unknown pg-boss queue: ${queueName}`);
  if (!isJobEnvelope(job.data)) throw new Error(`Invalid job envelope for ${job.id}`);

  const state: JobState = job.blocked && (job.state === "created" || job.state === "retry") ? "blocked" : job.state;
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
    traceContext: job.data.traceContext,
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
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    "input" in value &&
    queueDefinitions.some((queue) => queue.type === value.type)
  );
}

function isJobError(value: unknown): value is JobError {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.category === "string"
  );
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
  return new Date(
    Math.max(...values.filter((value): value is Date => value instanceof Date).map((value) => value.getTime()))
  );
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
