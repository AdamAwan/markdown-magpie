// Canonical domain types live in @magpie/core. The web app re-exports them here
// (rather than re-declaring them) so the console can never drift from the backend
// shapes. Only genuinely web-only types are declared locally below.
export type {
  AiExecutionMode,
  AiJob,
  AiJobStatus,
  AiJobType,
  AnswerResult,
  Citation,
  Confidence,
  CrunchFileWrite,
  CrunchOperation,
  CrunchPlan,
  CrunchRun,
  CrunchSettings,
  DocumentMetadata,
  GapCandidate,
  GitRepositoryContext,
  KnowledgeDocument,
  KnowledgeGapSignal,
  KnowledgeStatus,
  Proposal,
  ProposalPublication,
  QuestionFeedback,
  QuestionGap,
  QuestionLog,
  RepositoryRef,
  ScheduledTaskSettings,
  SuggestedGapCluster
} from "@magpie/core";

import type {
  AiExecutionMode,
  AiJob,
  AnswerResult,
  GapCandidate,
  Proposal,
  QuestionFeedback,
  ScheduledTaskSettings
} from "@magpie/core";

// Feedback was the local name for the core QuestionFeedback union; keep the alias
// so existing call sites continue to read naturally.
export type Feedback = QuestionFeedback;

// --- Web-only types (not part of the backend domain) -----------------------

export type ConsoleSection =
  | "ask"
  | "knowledge"
  | "gaps"
  | "jobs"
  | "proposals"
  | "snapshots"
  | "reconciliations"
  | "crunch"
  | "prompts"
  | "config"
  | "dataflow"
  | "mcp";
export type AiProviderName = "mock" | "openai-compatible" | "azure-openai" | "codex" | "claude";

export interface Health {
  ok: boolean;
  service: string;
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
    executionMode: AiExecutionMode;
    provider: AiProviderName;
    executionModes: AiExecutionMode[];
    directProviders: AiProviderName[];
    queueProviders: AiProviderName[];
    providers: Array<{
      name: AiProviderName;
      label: string;
      supportsDirect: boolean;
      supportsQueue: boolean;
    }>;
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

export interface UiMessage {
  id: number;
  text: string;
  tone: "info" | "success" | "danger";
}

export type JobTransitionMessage = Pick<UiMessage, "text" | "tone">;

export interface ScheduledTask {
  key: string;
  label: string;
  description: string;
  settings: ScheduledTaskSettings;
}

export interface AskResponse {
  mode: string;
  questionId: string;
  result?: AnswerResult;
  job?: AiJob;
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

// Mirrors the API's snapshot shapes (apps/api/src/stores/snapshot-store.ts). The
// web can't import server modules, so these are kept in sync by hand.
export interface SnapshotProposal {
  id: string;
  title?: string;
  status: Proposal["status"];
  gapClusterId?: string;
  pullRequestUrl?: string;
}

export interface SnapshotPullRequest {
  proposalId: string;
  url: string;
  merged: boolean;
  state: "open" | "closed" | "unknown";
  checkedAt: string;
}

export interface FlowSnapshot {
  flowId?: string;
  flowName: string;
  takenAt: string;
  catalogRevision: number;
  gaps: GapCandidate[];
  proposals: SnapshotProposal[];
  pullRequests: SnapshotPullRequest[];
}

// Mirrors the API's ReconciliationDecisionRecord
// (apps/api/src/stores/reconciliation-decision-store.ts).
export interface ReconciliationDecision {
  id: string;
  flowId?: string;
  kind: "merge" | "split";
  rationale: string;
  confirmed: boolean;
  applied: boolean;
  clusterIds: string[];
  createdAt: string;
}
