export type Confidence = "high" | "medium" | "low" | "unknown";

export type KnowledgeStatus = "active" | "draft" | "deprecated" | "archived";

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

export interface DocumentMetadata {
  title: string;
  owner?: string;
  status: KnowledgeStatus;
  lastVerified?: string;
  reviewCycleDays?: number;
  tags: string[];
  relatedDocs: string[];
}

export interface KnowledgeDocument {
  id: string;
  repositoryId: string;
  path: string;
  commitSha?: string;
  metadata: DocumentMetadata;
  content: string;
}

export interface DocumentSection {
  id: string;
  documentId: string;
  path: string;
  heading: string;
  headingPath: string[];
  anchor: string;
  content: string;
  ordinal: number;
}

export interface RankedSection {
  section: DocumentSection;
  /** Absolute relevance in [0,1]; higher is better. */
  relevance: number;
}

export interface Citation {
  documentId: string;
  sectionId: string;
  path: string;
  heading: string;
  anchor: string;
  commitSha?: string;
  excerpt: string;
}

export interface AnswerResult {
  answer: string;
  confidence: Confidence;
  citations: Citation[];
  gap?: KnowledgeGapSignal;
}

export interface KnowledgeGapSignal {
  summary: string;
  question: string;
  confidence: Confidence;
  citedSectionIds: string[];
}

export interface QuestionLog {
  id: string;
  question: string;
  executionMode: AiExecutionMode;
  chatProvider: string;
  confidence: Confidence;
  retrievedSectionIds: string[];
  askedAt: string;
  answer?: AnswerResult;
  feedback?: QuestionFeedback;
  feedbackAt?: string;
  gapSummary?: string;
  manualGap?: boolean;
  manualGapAt?: string;
}

export interface QuestionLogInput {
  question: string;
  executionMode: AiExecutionMode;
  chatProvider: string;
  answer?: AnswerResult;
  retrievedSectionIds: string[];
}

export interface QuestionLogUpdateInput {
  answer: AnswerResult;
  chatProvider?: string;
}

export type QuestionFeedback = "helpful" | "unhelpful";

export interface GapCandidate {
  summary: string;
  questionIds: string[];
  count: number;
  latestAskedAt: string;
  confidence: Confidence;
}

export interface GapCluster {
  id: string;
  summary: string;
  questionIds: string[];
  priority: number;
  status: "open" | "proposed" | "dismissed" | "resolved";
}

export interface Proposal {
  id: string;
  title: string;
  status: "draft" | "ready" | "branch-pushed" | "pr-opened" | "merged" | "rejected";
  targetPath: string;
  markdown: string;
  evidence: Citation[];
  gapClusterId?: string;
  gapSummary?: string;
  triggeringQuestionIds?: string[];
  destinationId?: string;
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

export interface ChatProvider {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export interface ChatRequest {
  system: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

export interface ChatResponse {
  content: string;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export type AiExecutionMode = "direct" | "queue";

export type AiJobType =
  | "answer_question"
  | "summarize_gap"
  | "draft_markdown_proposal"
  | "detect_contradiction"
  | "suggest_consolidation";

export type AiJobStatus = "pending" | "claimed" | "completed" | "failed" | "cancelled";

export interface AiJob<TInput = unknown, TOutput = unknown> {
  id: string;
  type: AiJobType;
  status: AiJobStatus;
  input: TInput;
  output?: TOutput;
  error?: string;
  claimedBy?: string;
  claimedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiJobQueue {
  enqueue<TInput>(type: AiJobType, input: TInput): Promise<AiJob<TInput>>;
  claimNext(workerName: string, acceptedTypes: AiJobType[]): Promise<AiJob | undefined>;
  complete<TOutput>(jobId: string, output: TOutput): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  get(jobId: string): Promise<AiJob | undefined>;
  list(): Promise<AiJob[]>;
}

export interface AgentRunner {
  name: string;
  supports(jobType: AiJobType): boolean;
  run(job: AiJob): Promise<unknown>;
}

export interface AnswerQuestionJobInput {
  questionLogId?: string;
  question: string;
  context: Array<{
    sectionId: string;
    path: string;
    heading: string;
    content: string;
  }>;
  expectedOutput: "answer_result";
}

export interface AnswerQuestionJobOutput {
  answer: string;
  confidence: Confidence;
  citations: Citation[];
  gap?: KnowledgeGapSignal;
}

export interface SummarizeGapJobInput {
  questions: string[];
  citedSections: Citation[];
  expectedOutput: "gap_summary";
}

export interface SummarizeGapJobOutput {
  summary: string;
  priority: number;
  rationale: string;
}

export interface DraftMarkdownProposalJobInput {
  gapSummary: string;
  triggeringQuestions: string[];
  evidence: Citation[];
  sourceContext?: SourceDataContext[];
  destinationId?: string;
  targetPath?: string;
  expectedOutput: "markdown_proposal";
}

export interface SourceDataContext {
  sourceId: string;
  sourceName: string;
  kind: "local" | "git" | "internet" | "agent";
  path?: string;
  url?: string;
  content?: string;
}

export interface DraftMarkdownProposalJobOutput {
  title: string;
  targetPath: string;
  markdown: string;
  rationale: string;
}

export interface PullRequestProvider {
  createPullRequest(request: CreatePullRequestRequest): Promise<CreatePullRequestResponse>;
}

export interface CreatePullRequestRequest {
  repository: RepositoryRef;
  branchName: string;
  title: string;
  body: string;
  changes: Array<{
    path: string;
    content: string;
  }>;
}

export interface CreatePullRequestResponse {
  id: string;
  url: string;
  status: "open";
}

export interface PublishProposalBranchRequest {
  repository: RepositoryRef;
  branchName: string;
  title: string;
  markdown: string;
  targetPath: string;
}

export interface PublishProposalBranchResponse {
  branchName: string;
  commitSha: string;
  remoteUrl?: string;
}
