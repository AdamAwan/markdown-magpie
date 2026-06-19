import type { ZodType } from "zod";

export const JOB_TYPES = [
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "crunch_knowledge_base",
  "cluster_gap_candidates",
  "refresh_pull_requests",
  "process_gaps_to_pull_requests",
  "trigger_scheduled_crunch",
  "publish_proposal",
  "publish_crunch"
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export const AI_PROVIDERS = ["openai-compatible", "azure-openai", "codex", "claude"] as const;

export type AiProviderName = (typeof AI_PROVIDERS)[number];
export type JobCapability = AiProviderName | "github" | "maintenance";
export type JobState =
  | "created"
  | "retry"
  | "active"
  | "completed"
  | "cancelled"
  | "failed"
  | "blocked";

export interface JobError {
  code: string;
  message: string;
  category: "provider" | "validation" | "configuration" | "timeout" | "external" | "internal";
  provider?: AiProviderName;
  details?: unknown;
  executor?: string;
}

export interface JobView<TInput = unknown, TOutput = unknown> {
  id: string;
  type: JobType;
  queueName: string;
  deadLetter: boolean;
  state: JobState;
  input: TInput;
  output?: TOutput;
  error?: JobError;
  retryCount: number;
  retryLimit: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  failedAt?: string;
  retryAt?: string;
  heartbeatAt?: string;
  heartbeatSeconds: number;
  expireInSeconds: number;
}

export interface JobPolicy {
  retryLimit: number;
  retryBackoff: "exponential";
  retryDelaySeconds: number;
  retryMaxDelaySeconds: number;
  heartbeatSeconds: number;
  expireInSeconds: number;
  retentionSeconds: number;
  deleteAfterSeconds: number;
  deadLetter?: string;
}

export interface JobDefinition<TInput = unknown, TOutput = unknown> {
  readonly type: JobType;
  readonly inputSchema: ZodType<TInput>;
  readonly outputSchema: ZodType<TOutput>;
  readonly policy: Readonly<JobPolicy>;
  readonly requiredCapability: (input: TInput) => JobCapability;
  readonly queueName: (input: TInput) => string;
}

export interface QueueDefinition {
  readonly name: string;
  readonly type: JobType;
  readonly capability?: JobCapability;
  readonly deadLetter: boolean;
  readonly policy?: Readonly<JobPolicy>;
}

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && (JOB_TYPES as readonly string[]).includes(value);
}

export function isAiProviderName(value: unknown): value is AiProviderName {
  return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}
