import type { JobCapability, JobError, JobState, JobType, JobView } from "@magpie/jobs";

export interface JobListFilters {
  type?: JobType;
  state?: JobState;
  createdAfter?: string;
  limit?: number; // 1–200
  offset?: number; // >= 0
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

export interface JobBroker {
  start(): Promise<void>;
  stop(): Promise<void>;
  // Whether start() has completed and stop() has not run since. Readiness reports
  // the broker as up from this without issuing a query.
  isStarted(): boolean;
  create(type: JobType, input: unknown): Promise<JobView>;
  // Hand the next runnable job to a watcher. Contract: queues holding
  // interactive-class jobs (INTERACTIVE_AI_JOB_TYPES — a live caller is waiting)
  // are offered before background/maintenance queues, so an answer_question is
  // never queued behind earlier patrol fan-out for a free watcher (#240).
  // Background queues are served round-robin so none starves its siblings.
  claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined>;
  heartbeat(id: string): Promise<JobView>;
  complete(id: string, output: unknown): Promise<JobView>;
  fail(id: string, error: JobError): Promise<JobView>;
  cancel(id: string): Promise<JobView>;
  retry(id: string): Promise<JobView>;
  get(id: string): Promise<JobView | undefined>;
  list(filters: JobListFilters): Promise<{ jobs: JobView[]; total: number }>;
  // Count jobs of the given types currently in flight (states created | retry |
  // active) across their work queues. Used by the API's AI cost controls to
  // enforce a global cap on concurrent metered work at enqueue time. Implemented
  // as a single aggregate count, not a list scan, so it is cheap on the hot path.
  countInFlight(types: JobType[]): Promise<number>;
  reconcileSchedules(schedules: DesiredSchedule[]): Promise<void>;
  listSchedules(): Promise<ScheduleView[]>;
  reset(): Promise<void>;
}
