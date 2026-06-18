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
  // A single question can expose several distinct knowledge gaps (e.g. asking
  // "how do I set this up with React so I can export dashboards?" is two gaps).
  // Each is tracked separately so it can cluster and become its own proposal.
  gaps?: KnowledgeGapSignal[];
}

export interface KnowledgeGapSignal {
  summary: string;
  question: string;
  confidence: Confidence;
  citedSectionIds: string[];
}

export type QuestionGapSource = "auto" | "manual";

export interface QuestionGap {
  summary: string;
  source: QuestionGapSource;
  // Set when a merged proposal closes this gap. A resolved gap is retained for
  // audit but no longer surfaces as a candidate.
  resolvedAt?: string;
  resolvedByProposalId?: string;
}

export interface QuestionLog {
  id: string;
  question: string;
  executionMode: AiExecutionMode;
  chatProvider: string;
  confidence: Confidence;
  retrievedSectionIds: string[];
  // The flow this question was routed to (scopes retrieval + persona). Recorded
  // so a gap can later be attributed to the flow that produced it. Absent for
  // un-routed/legacy questions.
  flowId?: string;
  askedAt: string;
  answer?: AnswerResult;
  feedback?: QuestionFeedback;
  feedbackAt?: string;
  gaps?: QuestionGap[];
  manualGap?: boolean;
  manualGapAt?: string;
}

export interface QuestionLogInput {
  question: string;
  executionMode: AiExecutionMode;
  chatProvider: string;
  answer?: AnswerResult;
  retrievedSectionIds: string[];
  flowId?: string;
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
  // The flow whose questions surfaced this gap. Candidates are grouped per flow,
  // so the same summary asked under two flows yields two candidates. Absent when
  // the underlying questions were not routed to a flow.
  flowId?: string;
}

export interface GapCluster {
  id: string;
  summary: string;
  questionIds: string[];
  priority: number;
  status: "open" | "proposed" | "dismissed" | "resolved";
}

// A semantic grouping of gap candidates that could be addressed by a single
// knowledge-base article (e.g. "do cats like cheese?", "is cheese bad for
// cats?", "what if a cat eats a lot of cheese?" are one cluster). Clusters are
// only ever *suggestions* — they are recomputed on demand and never persisted,
// because the human reviewer can regroup them before drafting. One drafted
// proposal is produced per cluster the reviewer confirms.
export interface SuggestedGapCluster {
  id: string;
  title: string;
  summaries: string[];
  questionIds: string[];
  count: number;
  rationale?: string;
  // Every member of a cluster belongs to the same flow (clustering runs per
  // flow), so a drafted proposal can default to this flow's destination/persona.
  flowId?: string;
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
  // Stamped when the proposal is marked merged. Marking merged also resolves the
  // gaps it closed so they stop surfacing as candidates.
  mergedAt?: string;
}

// Canonical location for a drafted proposal within its destination repository.
// The folder is always owned by us (the destination's configured docs subpath),
// never chosen by the AI or hard-coded per call site, so every proposal lands in
// a consistent place on its branch. The "proposed" state is represented by the
// branch/PR, so the doc is written to its final home — no staging prefix.
export function proposalFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${slug || "knowledge-gap"}.md`;
}

export function resolveProposalTargetPath(subpath: string | undefined, title: string): string {
  const folder = (subpath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const fileName = proposalFileName(title);
  return folder ? `${folder}/${fileName}` : fileName;
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
  | "suggest_consolidation"
  | "crunch_knowledge_base"
  | "sync_source_change";

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
  reset(): Promise<void>;
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
  // The flow the question was routed to, and that flow's persona snippet. Both are
  // carried in the job so the watcher (which has no flow config) can apply the
  // persona via buildJobPrompt. Absent when no flow matched / none configured.
  flowId?: string;
  persona?: string;
  expectedOutput: "answer_result";
}

// Result of routing a question to the single best-matching knowledge flow.
export interface FlowRouteDecision {
  flowId: string;
  confidence: Confidence;
  rationale?: string;
}

export interface AnswerQuestionJobOutput {
  answer: string;
  confidence: Confidence;
  citations: Citation[];
  gaps?: KnowledgeGapSignal[];
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
  // One proposal can address several related gaps at once (a confirmed cluster),
  // so the drafter receives every gap summary in the cluster and writes a single
  // cohesive article covering all of them.
  gapSummaries: string[];
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

// ---------------------------------------------------------------------------
// Crunch — scheduled knowledge-base tidying
//
// Over time an answer-driven knowledge base fragments: overlapping notes pile
// up and single documents grow to cover several unrelated topics. "Crunch" is a
// scheduled AI maintenance pass that proposes structural fixes — consolidating
// overlapping documents and splitting bloated ones — and lands the result on a
// review branch. Unlike a Proposal (one Markdown file), a crunch plan is
// inherently multi-file: it writes and deletes several documents at once.
// ---------------------------------------------------------------------------

export type CrunchOperationKind = "consolidate" | "split" | "rewrite";

export interface CrunchFileWrite {
  path: string;
  content: string;
}

export interface CrunchOperation {
  kind: CrunchOperationKind;
  title: string;
  reason: string;
  // Existing document paths this operation reorganizes (read and usually
  // replaced). Kept for the reviewer to see what was touched.
  sources: string[];
  writes: CrunchFileWrite[];
  deletes: string[];
}

export interface CrunchPlan {
  summary: string;
  operations: CrunchOperation[];
  rationale: string;
}

export interface CrunchKnowledgeBaseJobInput {
  flowId?: string;
  destinationId?: string;
  documents: CrunchFileWrite[];
  expectedOutput: "crunch_plan";
}

export type CrunchKnowledgeBaseJobOutput = CrunchPlan;

export type CrunchRunTrigger = "scheduled" | "manual";

export type CrunchRunStatus = "pending" | "running" | "completed" | "failed" | "published";

export interface CrunchRun {
  id: string;
  flowId?: string;
  destinationId?: string;
  trigger: CrunchRunTrigger;
  status: CrunchRunStatus;
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
  // Standard 5-field cron expression (minute hour day-of-month month day-of-week),
  // evaluated in the API server's local time zone.
  cron: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

// ---------------------------------------------------------------------------
// Source-change sync — keep the knowledge base honest against its sources
//
// Crunch reorganizes the knowledge base against *itself*. Source-change sync
// corrects it against its *sources*: when an upstream source commit changes the
// underlying behaviour the KB describes (e.g. a cutoff moves from 2024 to 2025),
// any KB document that still asserts the old fact is now wrong. This pass detects
// changed source commits, retrieves the KB documents that already speak to the
// change, and asks the model to rewrite only those documents to match the new
// reality — landing the result on a review branch. The plan reuses CrunchPlan:
// the output is the same multi-file write/delete changeset.
// ---------------------------------------------------------------------------

export type SourceSyncRunTrigger = "scheduled" | "manual";

// "skipped" records a detected source change that needed no KB edit (nothing in
// the KB matched it, or the model returned an empty plan) — kept for the operator
// to see that the change was considered.
export type SourceSyncRunStatus = "running" | "completed" | "failed" | "published" | "skipped";

// The last source commit a flow has reacted to. The next run diffs the source's
// new HEAD against this, so only genuinely new commits are processed.
export interface SourceSyncState {
  flowId?: string;
  sourceId: string;
  lastSha: string;
  lastCheckedAt: string;
}

export interface SourceChangeFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "other";
  diff: string;
}

// A knowledge-base document the change *might* affect — retrieved from the KB and
// handed to the model as the only documents it is allowed to edit.
export interface SourceSyncCandidateDocument {
  path: string;
  content: string;
}

export interface SourceChangeSyncJobInput {
  flowId?: string;
  destinationId?: string;
  sourceId: string;
  sourceName: string;
  fromSha: string;
  toSha: string;
  changes: SourceChangeFile[];
  candidateDocuments: SourceSyncCandidateDocument[];
  expectedOutput: "crunch_plan";
}

export type SourceChangeSyncJobOutput = CrunchPlan;

export interface SourceSyncRun {
  id: string;
  flowId?: string;
  destinationId?: string;
  sourceId: string;
  trigger: SourceSyncRunTrigger;
  status: SourceSyncRunStatus;
  jobId?: string;
  plan?: CrunchPlan;
  error?: string;
  fromSha?: string;
  toSha: string;
  changedFileCount: number;
  candidateCount: number;
  publication?: ProposalPublication;
  createdAt: string;
  completedAt?: string;
}

// Schedule for a generic background side-process (e.g. refreshing pull request
// status). Keyed by a stable task key from the server's task registry, so the
// Crunch page can drive any number of scheduled side-processes uniformly.
export interface ScheduledTaskSettings {
  key: string;
  enabled: boolean;
  cron: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

// --- Cron scheduling -------------------------------------------------------
// The 5-field cron evaluator lives in ./cron.ts; re-exported here so the
// public surface of @magpie/core is unchanged.
export { isValidCron, nextCronTime } from "./cron.js";

// Multi-file branch publish, used by Crunch (and any future change that touches
// more than one document at once). A change with `delete: true` removes the
// file; otherwise `content` is written.
export interface ChangesetChange {
  path: string;
  content?: string;
  delete?: boolean;
}

export interface PublishChangesetRequest {
  repository: RepositoryRef;
  branchName: string;
  title: string;
  changes: ChangesetChange[];
}

// The deterministic mock crunch planner lives in ./crunch-mock.ts; re-exported
// here so the public surface of @magpie/core is unchanged.
export { buildMockCrunchPlan } from "./crunch-mock.js";
