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
  create(type: JobType, input: unknown): Promise<JobView>;
  claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined>;
  heartbeat(id: string): Promise<JobView>;
  complete(id: string, output: unknown): Promise<JobView>;
  fail(id: string, error: JobError): Promise<JobView>;
  cancel(id: string): Promise<JobView>;
  retry(id: string): Promise<JobView>;
  get(id: string): Promise<JobView | undefined>;
  list(filters: JobListFilters): Promise<{ jobs: JobView[]; total: number }>;
  reconcileSchedules(schedules: DesiredSchedule[]): Promise<void>;
  listSchedules(): Promise<ScheduleView[]>;
  reset(): Promise<void>;
}
