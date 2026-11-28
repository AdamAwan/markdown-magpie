import type { JobCapability, JobError, JobState, JobType, JobView } from "@magpie/jobs";

export interface JobListFilters {
  type?: JobType;
  state?: JobState;
  createdAfter?: string;
  limit?: number; // 1–200
  offset?: number; // >= 0
}

// Criteria for findMatchingJobs: the "is one already queued/running?" guards.
// Scoped to the type's WORK queues (a dead-lettered copy is finished work, not
// a second job). `inFlight` keeps only not-yet-finished jobs (created | retry |
// active, which includes the derived `blocked`); `input` keeps only jobs whose
// input carries every listed field with exactly that value (JSON containment
// in the real broker). Every match is returned — no page limit — so a guard can
// never go blind behind a large backlog of retained, finished jobs.
export interface JobMatch {
  type: JobType;
  inFlight?: boolean;
  input?: Readonly<Record<string, string>>;
}

export interface DesiredSchedule {
  type: JobType;
  key: string;
  cron: string;
  input: unknown;
  enabled: boolean;
}

export interface ScheduleView {
  key: string;
  type: JobType;
  cron: string;
  enabled: boolean;
  nextRunAt?: string;
}

// The capacity envelope handed to createIfAdmitted: the in-flight ceiling to
// enforce, plus an optional reserved sub-lane. `types` are the job types counted
// toward the global figure; when `reserve` is present its `types` MUST be a
// subset of `types` (the reserve lane is a slice of the same global pool), and
// `reserved` slots are protected for that lane even when the global ceiling is
// otherwise full. This is the class-aware shape ai-capacity.ts builds from the
// interactive reserve (#240); admission control primitives consume it directly.
export interface InFlightCapacity {
  types: JobType[]; // counted for the global figure
  limit: number;
  reserve?: { types: JobType[]; reserved: number }; // reserve.types must be a subset of types
}

// The outcome of an atomic admission attempt. `job` is present iff `admitted`.
// `inFlight` and `reserveInFlight` are the counts observed UNDER THE LOCK at the
// moment the decision was made — the caller uses them to build an accurate 429
// (and callers/tests assert on them). `reserveInFlight` is populated only when a
// reserve lane was supplied.
export interface AdmissionResult {
  admitted: boolean;
  job?: JobView; // present iff admitted
  inFlight: number; // global count observed under the lock
  reserveInFlight?: number; // reserve-lane count, when a reserve was given
}

export interface JobBroker {
  start(): Promise<void>;
  stop(): Promise<void>;
  // Whether start() has completed and stop() has not run since. Readiness reports
  // the broker as up from this without issuing a query.
  isStarted(): boolean;
  create(type: JobType, input: unknown): Promise<JobView>;
  // Atomically count in-flight jobs and, only if that leaves capacity, enqueue —
  // both under a single cluster-wide advisory lock, so concurrent callers can no
  // longer overshoot the ceiling via a check-then-act race (the TOCTOU that
  // countInFlight + a separate create() suffers). Returns whether the job was
  // admitted, the just-created JobView when it was, and the in-flight counts
  // observed under the lock. This is the reusable admission-control primitive for
  // #288: sub-item (a) gates POST /api/ask through it, and sub-item (b) will pass
  // its own (non-interactive) capacity to admission-control maintenance fan-out —
  // sharing one lock key so the global count stays mutually exclusive. The block
  // rule (evaluated in JS from the observed counts) is:
  //   blocked = capacity.reserve
  //     ? (reserveInFlight >= capacity.reserve.reserved && inFlight >= capacity.limit)
  //     : (inFlight >= capacity.limit)
  createIfAdmitted(type: JobType, input: unknown, capacity: InFlightCapacity): Promise<AdmissionResult>;
  // Hand the next runnable job to a watcher. Contract: queues holding
  // interactive-class jobs (INTERACTIVE_AI_JOB_TYPES — a live caller is waiting)
  // are offered before background/maintenance queues, so an answer_question is
  // never queued behind earlier patrol fan-out for a free watcher (#240).
  // Background queues are served round-robin so none starves its siblings.
  claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined>;
  heartbeat(id: string): Promise<JobView>;
  complete(id: string, output: unknown): Promise<JobView>;
  fail(id: string, error: JobError): Promise<JobView>;
  // Fail a job straight to the terminal `failed` state, skipping any remaining
  // retries, recording the error and routing it to the dead-letter queue exactly
  // as retry-exhaustion would (#288d). Used as the backstop for a reproducible
  // contract violation (schema-invalid watcher output) so it burns zero further
  // paid generations instead of spending the full retry budget. A no-op on a job
  // already in a terminal state, mirroring `fail` (protects the completion-replay
  // contract).
  failTerminal(id: string, error: JobError): Promise<JobView>;
  cancel(id: string): Promise<JobView>;
  retry(id: string): Promise<JobView>;
  get(id: string): Promise<JobView | undefined>;
  // One page of jobs, newest first (created time descending), with `total` the
  // exact number of jobs matching the filters across every page. Filtering,
  // ordering and paging all happen over the whole job set, so the page is the
  // true newest `limit` jobs however many finished jobs are retained. This is a
  // console/report read: do NOT build an "already in flight?" guard on it — a
  // page can miss an in-flight job — use findMatchingJobs.
  list(filters: JobListFilters): Promise<{ jobs: JobView[]; total: number }>;
  // Every job matching `match`, newest first (see JobMatch). The primitive for
  // dedupe/overlap guards: filters by state and input in the store itself, so the
  // answer is complete regardless of how many other jobs the type's queues hold.
  findMatchingJobs(match: JobMatch): Promise<JobView[]>;
  // Count jobs of the given types currently in flight (states created | retry |
  // active) across their work queues. Used by the API's AI cost controls to
  // enforce a global cap on concurrent metered work at enqueue time. Implemented
  // as a single aggregate count, not a list scan, so it is cheap on the hot path.
  countInFlight(types: JobType[]): Promise<number>;
  reconcileSchedules(schedules: DesiredSchedule[]): Promise<void>;
  listSchedules(): Promise<ScheduleView[]>;
  reset(): Promise<void>;
}
