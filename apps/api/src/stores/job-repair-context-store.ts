import type { JobType } from "@magpie/jobs";

// One out-of-band repair-context row for a schema-invalid provider job getting a
// single informed repair (#288d). Keyed by job id. `targetType` is the job type
// being repaired (kept for observability/scoping; the JobView already carries the
// type), `priorOutput` is the exact invalid output to reshape, `issues` are the
// Zod contract violations the reshape must fix, and `attempt` is always 1 —
// repair-of-a-repair is structurally impossible (a repair run already carries a
// row, so a second invalid output terminal-fails).
export interface JobRepairContextRow {
  jobId: string;
  targetType: JobType;
  priorOutput: unknown;
  issues: Array<{ path: string; message: string }>;
  attempt: number;
  createdAt?: string;
}

// The write shape: createdAt is assigned by the store.
export type JobRepairContextInput = Omit<JobRepairContextRow, "createdAt">;

// The bounded state for the repair-reprompt path (#288d). The presence of a row
// IS the "one repair" counter: repair is offered only when get() returns nothing,
// and every repair run carries a row, so a second schema-invalid output falls
// through to the terminal backstop. Rows are deleted on success and on terminal
// failure.
export interface JobRepairContextStore {
  get(jobId: string): Promise<JobRepairContextRow | undefined>;
  put(row: JobRepairContextInput): Promise<void>;
  delete(jobId: string): Promise<void>;
  reset(): Promise<void>;
}

export class InMemoryJobRepairContextStore implements JobRepairContextStore {
  private readonly rows = new Map<string, JobRepairContextRow>();

  async get(jobId: string): Promise<JobRepairContextRow | undefined> {
    return this.rows.get(jobId);
  }

  async put(row: JobRepairContextInput): Promise<void> {
    const createdAt = this.rows.get(row.jobId)?.createdAt ?? new Date().toISOString();
    this.rows.set(row.jobId, { ...row, createdAt });
  }

  async delete(jobId: string): Promise<void> {
    this.rows.delete(jobId);
  }

  async reset(): Promise<void> {
    this.rows.clear();
  }
}
