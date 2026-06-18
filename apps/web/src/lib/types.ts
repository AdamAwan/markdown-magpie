export type Confidence = "high" | "medium" | "low" | "unknown";
export type Feedback = "helpful" | "unhelpful";
export type ConsoleSection = "ask" | "knowledge" | "gaps" | "jobs" | "proposals" | "crunch" | "prompts" | "config" | "dataflow";
export type AiExecutionMode = "direct" | "queue";
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

export interface KnowledgeDocument {
  id: string;
  repositoryId: string;
  path: string;
  commitSha?: string;
  metadata: {
    title: string;
    owner?: string;
    status: string;
    tags: string[];
  };
  content: string;
}

export interface RepositoryRef {
  id: string;
  name: string;
  remoteUrl?: string;
  defaultBranch: string;
  localPath: string;
  provider: "local" | "github" | "gitlab" | "azure-devops";
  git?: GitRepositoryContext;
}

export interface GitRepositoryContext {
  scope: "repository-root" | "subdirectory" | "not-git";
  indexedPath: string;
  workTreeRoot?: string;
  relativePathFromRoot?: string;
  currentBranch?: string;
  defaultBranch?: string;
  headSha?: string;
  remoteUrl?: string;
  hasUncommittedChanges?: boolean;
}

export interface Citation {
  sectionId: string;
  path: string;
  heading: string;
  anchor: string;
  excerpt: string;
}

export interface AnswerResult {
  answer: string;
  confidence: Confidence;
  citations: Citation[];
  gaps?: {
    summary: string;
    question: string;
  }[];
}

export interface QuestionLog {
  id: string;
  question: string;
  executionMode: string;
  chatProvider: string;
  confidence: Confidence;
  retrievedSectionIds: string[];
  askedAt: string;
  answer?: AnswerResult;
  feedback?: Feedback;
  manualGap?: boolean;
}

export interface GapCandidate {
  summary: string;
  questionIds: string[];
  count: number;
  latestAskedAt: string;
  confidence: Confidence;
}

export interface SuggestedGapCluster {
  id: string;
  title: string;
  summaries: string[];
  questionIds: string[];
  count: number;
  rationale?: string;
}

export interface AiJob {
  id: string;
  type: string;
  status: string;
  claimedBy?: string;
  createdAt: string;
  updatedAt: string;
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

export interface Proposal {
  id: string;
  title: string;
  status: "draft" | "ready" | "branch-pushed" | "pr-opened" | "merged" | "rejected";
  targetPath: string;
  markdown: string;
  gapSummary?: string;
  triggeringQuestionIds?: string[];
  rationale?: string;
  jobId?: string;
  publication?: ProposalPublication;
  createdAt: string;
}

export interface ProposalPublication {
  provider: "local-git";
  branchName: string;
  commitSha: string;
  remoteUrl?: string;
  pullRequestUrl?: string;
  publishedAt: string;
}

export interface CrunchFileWrite {
  path: string;
  content: string;
}

export interface CrunchOperation {
  kind: "consolidate" | "split" | "rewrite";
  title: string;
  reason: string;
  sources: string[];
  writes: CrunchFileWrite[];
  deletes: string[];
}

export interface CrunchPlan {
  summary: string;
  operations: CrunchOperation[];
  rationale: string;
}

export interface CrunchRun {
  id: string;
  flowId?: string;
  destinationId?: string;
  trigger: "scheduled" | "manual";
  status: "pending" | "running" | "completed" | "failed" | "published";
  jobId?: string;
  plan?: CrunchPlan;
  error?: string;
  documentCount: number;
  publication?: ProposalPublication;
  createdAt: string;
  completedAt?: string;
}

export interface CrunchSettings {
  flowId?: string;
  enabled: boolean;
  cron: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface ScheduledTaskSettings {
  key: string;
  enabled: boolean;
  cron: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

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
