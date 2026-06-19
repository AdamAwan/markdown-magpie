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

// What GET /api/gaps/clusters now returns: an active persisted cluster. Keeps
// every field SuggestedGapCluster exposed (so the UI is unchanged) and adds the
// persisted lineage fields. `id` is a stable surrogate that survives membership
// changes — unlike the content-hash id the on-demand clusterer produced.
export interface PersistedGapCluster {
  id: string;
  title: string;
  summaries: string[];
  questionIds: string[];
  count: number;
  rationale?: string;
  flowId?: string;
  status: "active";
  proposalId?: string;
  proposalStatus?: Proposal["status"];
  lastReconciledAt?: string;
}

export interface Proposal {
  id: string;
  title: string;
  status: "draft" | "ready" | "branch-pushed" | "pr-opened" | "merged" | "rejected" | "superseded";
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
  // A compact record of the context the model was given when it drafted this
  // proposal — the gaps, the source files, how much evidence, and the flow's
  // in-flight work it was told about. Lets a reviewer see what the draft was
  // based on, not just its output. Absent on proposals drafted before this was
  // captured.
  draftContext?: DraftContext;
  createdAt: string;
  // Stamped when the proposal is marked merged. Marking merged also resolves the
  // gaps it closed so they stop surfacing as candidates.
  mergedAt?: string;
}

// The inputs handed to the drafter, kept alongside the proposal so the context
// is inspectable after the fact regardless of execution mode (direct or queued).
// Deliberately compact: source file identities, not their bodies.
export interface DraftContext {
  // The gap summaries the draft set out to close.
  gapSummaries: string[];
  // The source files the model received as raw material (identity only).
  sourceFiles: Array<{ sourceName: string; path?: string; url?: string }>;
  // How many evidence citations were attached.
  evidenceCount: number;
  // The flow's in-flight proposals / open pull requests the model was shown.
  openPullRequests: OpenPullRequestContext[];
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
  // The flow's already in-flight proposals and currently open pull requests, so
  // the drafter is aware of work it should build on or avoid duplicating rather
  // than drafting in a vacuum. Optional and defaults to absent.
  openPullRequests?: OpenPullRequestContext[];
  destinationId?: string;
  targetPath?: string;
  expectedOutput: "markdown_proposal";
}

// One piece of in-flight drafting work in a flow, surfaced to a new draft so it
// can cross-reference or steer clear of it. Sourced from the flow's on-disk
// snapshot — not a live host lookup.
export interface OpenPullRequestContext {
  // What the in-flight work is about.
  title: string;
  // The pull request URL once one is open; absent while the proposal is still in
  // draft/ready/branch-pushed (no PR raised yet).
  url?: string;
  // The destination document the work targets, so a draft can avoid landing a
  // second article on the same path.
  targetPath?: string;
  // Where the work currently sits in the publish lifecycle.
  status: Proposal["status"];
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
  // Set while a run (scheduled or manual) is in flight, and cleared when it
  // finishes. The UI disables "Run now" while this is set, and both trigger
  // paths refuse to start an overlapping run.
  runningSince?: string;
}

// --- Cron scheduling -------------------------------------------------------
// A small, dependency-free evaluator for standard 5-field cron expressions:
//   minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6)
// Supports "*", lists (a,b), ranges (a-b), and steps (*/n, a-b/n). Sunday is 0
// (7 is also accepted as Sunday). Times are evaluated in local time.
//
// Caveat: evaluation is in local wall-clock time and nextCronTime scans
// minute-by-minute, so around DST transitions a "skipped" local hour can be
// missed and a "repeated" local hour can match twice. Acceptable for the
// coarse maintenance schedules this drives; revisit if minute-precision
// correctness across DST is ever required.

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCronField(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    const rangePart = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 1;
    if (step <= 0) {
      return undefined;
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(rangePart);
      if (range) {
        lo = Number.parseInt(range[1], 10);
        hi = Number.parseInt(range[2], 10);
      } else if (/^\d+$/.test(rangePart)) {
        lo = Number.parseInt(rangePart, 10);
        hi = lo;
      } else {
        return undefined;
      }
    }

    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max || lo > hi) {
      return undefined;
    }
    for (let value = lo; value <= hi; value += step) {
      values.add(value);
    }
  }
  return values.size > 0 ? values : undefined;
}

function parseCronExpression(expr: string): CronFields | undefined {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return undefined;
  }

  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dayOfMonth = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dayOfWeek = parseCronField(parts[4].replace(/7/g, "0"), 0, 6);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return undefined;
  }

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*"
  };
}

export function isValidCron(expr: string): boolean {
  return parseCronExpression(expr) !== undefined;
}

function cronMatches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) {
    return false;
  }
  if (!fields.hour.has(date.getHours())) {
    return false;
  }
  if (!fields.month.has(date.getMonth() + 1)) {
    return false;
  }

  const domMatch = fields.dayOfMonth.has(date.getDate());
  const dowMatch = fields.dayOfWeek.has(date.getDay());
  // Vixie-cron rule: when both day-of-month and day-of-week are restricted, a
  // match on either one counts; otherwise both must match.
  if (fields.domRestricted && fields.dowRestricted) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

// The next minute that matches `expr`, strictly after `from`, or undefined if the
// expression is invalid (or — practically never — has no match within a year).
export function nextCronTime(expr: string, from: Date): Date | undefined {
  const fields = parseCronExpression(expr);
  if (!fields) {
    return undefined;
  }

  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (cronMatches(fields, candidate)) {
      return new Date(candidate.getTime());
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return undefined;
}

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

function crunchSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "section"
  );
}

function documentFolder(filePath: string): string {
  const segments = filePath.replace(/\\/g, "/").split("/");
  return segments.length > 1 ? segments.slice(0, -1).join("/") : "";
}

function countHeadings(content: string, level: number): string[] {
  const prefix = `${"#".repeat(level)} `;
  return content
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
    .filter(Boolean);
}

// Deterministic, dependency-free tidy heuristics shared by the API's direct
// mock executor and the watcher's mock runner so demos and tests agree:
//   - SPLIT a document that has grown large (> 1,800 chars) and covers several
//     topics (>= 3 level-2 headings) into one file per "##" section.
//   - CONSOLIDATE a folder that has fragmented into several small documents
//     (>= 2 docs, each < 1,200 chars, none being split) into one overview file.
// Real providers replace this with a model call; the shape of the output is the
// same CrunchPlan either way.
export function buildMockCrunchPlan(documents: CrunchFileWrite[]): CrunchPlan {
  const operations: CrunchOperation[] = [];
  const splitPaths = new Set<string>();

  for (const document of [...documents].sort((left, right) => left.path.localeCompare(right.path))) {
    const sections = countHeadings(document.content, 2);
    if (document.content.length <= 1800 || sections.length < 3) {
      continue;
    }

    splitPaths.add(document.path);
    const folder = documentFolder(document.path);
    const baseName = (document.path.replace(/\\/g, "/").split("/").at(-1) ?? document.path).replace(/\.md$/i, "");
    const baseDir = folder ? `${folder}/${crunchSlug(baseName)}` : crunchSlug(baseName);
    const blocks = splitByHeading(document.content, 2);
    const writes: CrunchFileWrite[] = blocks.map((block) => ({
      path: `${baseDir}/${crunchSlug(block.heading)}.md`,
      content: `# ${block.heading}\n\n${block.body.trim()}\n`
    }));

    operations.push({
      kind: "split",
      title: `Split ${document.path} into ${writes.length} focused documents`,
      reason: `This document is ${document.content.length} characters across ${sections.length} top-level sections, mixing several topics. Splitting one section per file keeps each document focused and easier to retrieve.`,
      sources: [document.path],
      writes,
      deletes: [document.path]
    });
  }

  const byFolder = new Map<string, CrunchFileWrite[]>();
  for (const document of documents) {
    if (splitPaths.has(document.path)) {
      continue;
    }
    if (document.content.length >= 1200) {
      continue;
    }
    const folder = documentFolder(document.path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), document]);
  }

  for (const [folder, folderDocuments] of [...byFolder.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (folderDocuments.length < 2) {
      continue;
    }

    const sorted = [...folderDocuments].sort((left, right) => left.path.localeCompare(right.path));
    const overviewPath = folder ? `${folder}/overview.md` : "overview.md";
    const heading = folder ? `${folder} overview` : "Overview";
    const body = sorted
      .map((document) => {
        const title = (document.path.replace(/\\/g, "/").split("/").at(-1) ?? document.path).replace(/\.md$/i, "");
        return `## ${title}\n\n${stripFrontmatter(document.content).trim()}`;
      })
      .join("\n\n");

    operations.push({
      kind: "consolidate",
      title: `Consolidate ${sorted.length} small documents in ${folder || "the root"} into one overview`,
      reason: `${sorted.length} short documents (each under 1,200 characters) cover closely related material in the same folder. Merging them into a single overview reduces fragmentation and duplicate context.`,
      sources: sorted.map((document) => document.path),
      writes: [{ path: overviewPath, content: `# ${heading}\n\n${body}\n` }],
      deletes: sorted.map((document) => document.path)
    });
  }

  return {
    summary:
      operations.length === 0
        ? "The knowledge base already looks tidy — no consolidations or splits are needed."
        : `${operations.length} tidy operation(s): ${operations.filter((operation) => operation.kind === "split").length} split, ${operations.filter((operation) => operation.kind === "consolidate").length} consolidate.`,
    operations,
    rationale: "Generated by the deterministic mock crunch planner from document size and folder fragmentation heuristics."
  };
}

function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

function splitByHeading(content: string, level: number): Array<{ heading: string; body: string }> {
  const prefix = `${"#".repeat(level)} `;
  const lines = stripFrontmatter(content).split(/\r?\n/);
  const blocks: Array<{ heading: string; body: string }> = [];
  let current: { heading: string; body: string[] } | undefined;

  for (const line of lines) {
    if (line.startsWith(prefix)) {
      if (current) {
        blocks.push({ heading: current.heading, body: current.body.join("\n") });
      }
      current = { heading: line.slice(prefix.length).trim() || "Section", body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }

  if (current) {
    blocks.push({ heading: current.heading, body: current.body.join("\n") });
  }

  return blocks;
}
