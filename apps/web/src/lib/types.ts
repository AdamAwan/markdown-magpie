// Canonical domain types live in @magpie/core. The web app re-exports them here
// (rather than re-declaring them) so the console can never drift from the backend
// shapes. Only genuinely web-only types are declared locally below.
export type {
  AnswerResult,
  AnswerTrace,
  ChangeIntentTrace,
  Citation,
  Confidence,
  MaintenanceRun,
  DocumentMetadata,
  GapCandidate,
  GitRepositoryContext,
  KnowledgeDocument,
  KnowledgeGapSignal,
  KnowledgeStatus,
  ParkedQuestion,
  Proposal,
  ProposalPublication,
  QuestionFeedback,
  QuestionGap,
  QuestionLog,
  RepositoryRef,
  ScheduledTaskSettings,
  SourceMapEntry,
  SuggestedGapCluster,
  WatcherStatus,
  WatcherView
} from "@magpie/core";

import type {
  KnowledgeDocument,
  ParkedQuestion,
  QuestionFeedback,
  RepositoryRef,
  ScheduledTaskSettings,
  SourceMapEntry,
  WatcherView
} from "@magpie/core";

// Queue/job domain types live in @magpie/jobs (the pg-boss contract). The web
// re-exports the TYPES so the console's job/schedule views never drift from the
// broker's shapes. We deliberately do NOT import the runtime AI_PROVIDERS value
// from @magpie/jobs into the client bundle: that package pulls in zod and the
// whole job catalog, none of which the browser needs. Instead the four provider
// names are declared here as a static client-side constant, and `satisfies`
// pins them to the AiProviderName contract so the two can never drift.
export type { AiProviderName, JobCapability, JobError, JobState, JobType, JobView } from "@magpie/jobs";

import type { AiProviderName, JobType, JobView } from "@magpie/jobs";

// The four AI providers a watcher can run. API-side credentials do not gate
// availability (watchers hold the credentials), so all four are always offered.
export const AI_PROVIDERS = [
  "openai-compatible",
  "azure-openai",
  "codex",
  "claude"
] as const satisfies readonly AiProviderName[];

// Feedback was the local name for the core QuestionFeedback union; keep the alias
// so existing call sites continue to read naturally.
export type Feedback = QuestionFeedback;

// Response of GET /api/questions/parked (the parked-gap human workflow, #158):
// questions awaiting a human plus the read-only missing-log proposal escalations.
export interface ParkedProposalView {
  proposalId: string;
  title: string;
  reason: "triggering_question_deleted";
}
export interface ParkedView {
  questions: ParkedQuestion[];
  proposals: ParkedProposalView[];
}

// --- Web-only types (not part of the backend domain) -----------------------

export type ConsoleSection =
  | "ask"
  | "knowledge"
  | "gaps"
  | "seed"
  | "source-map"
  | "jobs"
  | "proposals"
  | "activity"
  | "insights"
  | "schedules"
  | "prompts"
  | "config"
  | "dataflow"
  | "mcp";

export interface Health {
  ok: boolean;
  service: string;
}

// Identity of the running API build, served by GET /api/version. Every field is
// null when the image was built without the build args (local dev).
export interface BuildInfo {
  sha: string | null;
  commitMessage: string | null;
  committedAt: string | null;
}

export interface PromptSummary {
  id: string;
  title: string;
  description: string;
  usedBy: string[];
  outputShape: string;
  instructions: string;
}

export interface KnowledgeStats {
  repositoryCount: number;
  documentCount: number;
  sectionCount: number;
}

export interface RuntimeConfig {
  api: Record<string, string | number | null>;
  stores: Record<string, string | number | null>;
  knowledge: {
    repositoryPath: string | null;
    repositories?: ConfiguredKnowledgeRepository[];
    sources?: ConfiguredKnowledgeRepository[];
    destinations?: ConfiguredKnowledgeRepository[];
    flows?: ConfiguredKnowledgeFlow[];
    checkoutRoot?: string;
  };
  providers: Record<string, unknown>;
  aiRuntime: {
    // The active provider the queue uses. Execution mode and per-provider
    // direct/queue support are no longer surfaced in the console: in the
    // queue-only world the API never runs AI inline, and watchers hold the
    // provider credentials, so any of the static AI_PROVIDERS can be selected.
    provider: AiProviderName;
  };
  retrieval: {
    mode: "hybrid" | "keyword";
    reason: string;
    embeddingProvider: string | null;
  };
  watcher: Record<string, string | number | null>;
}

export interface ConfiguredKnowledgeRepository {
  id: string;
  name: string;
  path?: string;
  url?: string;
  branch?: string;
  subpath?: string;
  kind?: "local" | "git" | "internet" | "agent";
}

export interface ConfiguredKnowledgeFlow {
  id: string;
  name: string;
  sourceIds: string[];
  destinationId: string;
  persona?: string;
}

export interface ConsoleNotice {
  id: string;
  title: string;
  body: string;
  tone: "warning" | "info" | "danger";
  actionLabel?: string;
  action?: () => void;
}

// One entry in the console's notification feed: transient action feedback
// (queued/completed/failed messages). Each shows as a toast and is kept —
// newest first, bounded — in the status pill's dropdown so a missed toast is
// still recoverable. Session state only, never persisted.
export interface UiNotification {
  id: number;
  text: string;
  tone: "info" | "success" | "danger";
  at: string;
  read: boolean;
}

export type JobTransitionMessage = Pick<UiNotification, "text" | "tone">;

// Mirrors the API's reconciled schedule response (apps/api/src/jobs/broker.ts
// ScheduleView). Next-run timing is owned by pg-boss; the web reads it from
// `/jobs/schedules` rather than from any API tick loop.
export interface ScheduleView {
  key: string;
  type: JobType;
  cron: string;
  enabled: boolean;
  nextRunAt?: string;
}

// `/jobs` is paginated: it returns the page of jobs plus the unpaginated total.
export interface JobsResponse {
  jobs: JobView[];
  total: number;
}

// `/workers` returns the watchers currently connected (seen within the API's
// active window), busy or idle. Drives the Jobs screen's Workers panel.
// `uncoveredJobTypes` is the fleet's capability gap — job types no active watcher
// can run — computed by the API (so the browser needs no job catalog) and surfaced
// as the "no watcher can run these jobs" console banner.
export interface WorkersResponse {
  workers: WatcherView[];
  uncoveredJobTypes: JobType[];
}

// `/knowledge/documents` and `/knowledge/repositories` are paginated the same
// way as `/jobs`: a page of items plus the unpaginated total.
export interface KnowledgeDocumentsResponse {
  documents: KnowledgeDocument[];
  total: number;
}

export interface KnowledgeRepositoriesResponse {
  repositories: RepositoryRef[];
  total: number;
}

// The scheduled-task list response enriches the stored settings with the next
// run time from the reconciled pg-boss schedule. `lastRunAt`/`runningSince` are
// gone server-side (no API tick loop maintains them), so they are not modelled.
export type ScheduledTaskSettingsView = ScheduledTaskSettings & { nextRunAt?: string };

export interface ScheduledTask {
  key: string;
  // `baseKey` is the flow-free task type (shared across flows); `flowId` identifies
  // the flow this instance runs for. The console groups the schedules table by one
  // axis or the other, so it relies on these rather than splitting `label`/`key`.
  baseKey: string;
  flowId?: string;
  // Flow-free type name (e.g. "Clustered gaps → pull requests"); `label` adds the flow.
  typeLabel: string;
  label: string;
  description: string;
  settings: ScheduledTaskSettingsView;
}

// The ask response is now enqueue-only: it returns the question id and the
// queued answer_question job (plus follow-up links). There is no inline answer.
export interface AskLinks {
  question: string;
  job: string;
  wait: string;
  cancel: string;
}

export interface AskResponse {
  questionId: string;
  job: JobView;
  links?: AskLinks;
}

export interface SourceMapResponse {
  entries: SourceMapEntry[];
}

export interface IndexRepositoryResponse {
  documentCount: number;
  sectionCount: number;
  repository: {
    id: string;
    name: string;
    localPath: string;
  };
}

// The snapshot and reconciliation shapes are canonical domain types in
// @magpie/core, shared with the api store, so they can never drift from the
// backend. The console reads `FlowSnapshotView` over /snapshots (the store
// FlowSnapshot plus its flow label) and `ReconciliationDecisionRecord` over
// /reconciliations; we re-export them under the console's established names.
export type {
  FlowSnapshotView as FlowSnapshot,
  ReconciliationDecisionRecord as ReconciliationDecision
} from "@magpie/core";

// Insights chart response shapes, defined once in @magpie/core and consumed by
// the Insights page and its chart components.
export type {
  GapBacklogBucket,
  JobThroughputBucket,
  JourneyNode,
  JourneyLink,
  JourneySankey,
  JourneySegment,
  InsightsBucketUnit,
  LatencyBin,
  VerificationSummary,
  VerificationBucket,
  FeedbackSummary,
  FeedbackBucket,
  JobErrorBreakdown,
  DocumentFreshness,
  SourceFreshness,
  FreshnessSummary,
  PatrolImpact,
  AiUsageBreakdown,
  AiCostByFlow
} from "@magpie/core";
