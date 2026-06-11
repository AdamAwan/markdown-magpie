export type JobName =
  | "repo.sync"
  | "docs.index_changed"
  | "questions.cluster_gaps"
  | "proposals.generate_for_top_gaps"
  | "pull_requests.refresh_status";

export interface JobDefinition<TPayload = unknown> {
  name: JobName;
  schedule?: string;
  handler(payload: TPayload): Promise<void>;
}

export const defaultJobSchedule: Array<Pick<JobDefinition, "name" | "schedule">> = [
  { name: "repo.sync", schedule: "*/15 * * * *" },
  { name: "questions.cluster_gaps", schedule: "0 * * * *" },
  { name: "proposals.generate_for_top_gaps", schedule: "0 2 * * *" },
  { name: "pull_requests.refresh_status", schedule: "*/10 * * * *" }
];
