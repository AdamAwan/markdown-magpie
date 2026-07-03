import type { ZodType } from "zod";

export const JOB_TYPES = [
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "draft_seed_document",
  "outline_flow_seed",
  "fold_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "reconcile_gap_clusters",
  "sync_source_changes_generate_plan",
  "verify_document",
  "correct_document",
  "dedupe_documents",
  "split_document",
  "improve_document",
  "fold_changeset_proposal",
  "refresh_flow_snapshot",
  "process_gaps_to_pull_requests",
  "source_change_sync",
  "correctness_patrol",
  "editorial_patrol",
  "publish_proposal",
  "crosslink_pull_requests",
  "comment_pull_request"
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export const AI_PROVIDERS = ["openai-compatible", "azure-openai", "codex", "claude"] as const;

export type AiProviderName = (typeof AI_PROVIDERS)[number];
// `local-git` publishes a proposal branch to a file:// destination: it needs git
// and a commit identity but NO GitHub token, so a token-less watcher can do it.
// `github` additionally opens pull requests (and does crosslink/comment work).
export type JobCapability = AiProviderName | "github" | "maintenance" | "local-git";
export type JobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed" | "blocked";

export interface JobError {
  code: string;
  message: string;
  category: "provider" | "validation" | "configuration" | "timeout" | "external" | "internal";
  provider?: string;
  details?: Record<string, string | number | boolean | null>;
  executor?: string;
}

export interface JobView<TInput = unknown, TOutput = unknown> {
  id: string;
  type: JobType;
  queueName: string;
  deadLetter: boolean;
  state: JobState;
  input: TInput;
  // The W3C trace context (traceparent/tracestate) captured by the API when the
  // job was enqueued, when telemetry is enabled. Absent for jobs enqueued outside
  // a trace (e.g. scheduled fires) or in a build with telemetry off. The watcher
  // extracts it to run the job's span within the enqueueing request's trace.
  traceContext?: Record<string, string>;
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
  acceptedAt?: string;
  retryAt?: string;
  heartbeatAt?: string;
  heartbeatSeconds?: number;
  expireInSeconds: number;
}

export interface JobPolicy {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: true;
  retryDelayMax: number;
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
  // Every concrete capability this type can route to: one entry for a statically
  // scoped job, the four AI providers for provider-routed work, or the fan-out set
  // (e.g. [github, local-git] for publish_proposal). Drives queue provisioning and
  // the console's capability→job-type coverage map.
  readonly capabilities: readonly JobCapability[];
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
